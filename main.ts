// Tiny trend bot: multi-asset EMA-crossover momentum with a volatility filter,
// ATR trailing stops, staged (scale-in) entries and an equity drawdown guard.
//
// How it trades the bars-replay/v1 protocol: the hello message gives the capital,
// the symbols and the caps; each batch of bars is one hour of closes for the
// universe, and the bot answers that batch with its orders for the next bar's
// open (1-bar latency). A reply never spends a sell's proceeds on a buy of the
// same reply, and every order is capped at 100 bps of slippage past the close
// it was decided on. No clock, no randomness, no network: the same bars always
// give the same orders, run after run.
//
// Rules, per symbol, over its own closes:
//   - Trend: EMA(8) crosses above EMA(21), the close sits above EMA(30), and
//     the 12-hour momentum (close vs the close 12 bars back) is positive.
//   - Entry is staged: half the stake on the cross, the other half two bars
//     later if the trend still holds, so a one-bar whipsaw costs half a stake.
//   - Exit the whole position when EMA(8) crosses back under EMA(21), the
//     close falls under EMA(30), the close drops more than 1.5x ATR(14) under
//     the highest close since entry, the position is 8% under its cost, or it
//     is 50% over its cost.
//   - Size: 10% of equity per position (under the 25% weight cap), at most one
//     position per symbol, at most seven open at once.
//   - Drawdown guard: no new entries once equity is 10% under its peak; exit
//     everything at 15% under the peak.
//   - Indicators seed on the first close and trading starts after 21 bars, so
//     the EMAs have settled before the first order is sent.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 8;
const SLOW_SPAN = 21;
const LONG_SPAN = 30;
const ATR_SPAN = 14;
const MOMENTUM_BARS = 12;
const MIN_BARS = 21;
const SCALE_IN_BARS = 2;
const TRAIL_ATR = 1.5;
const STOP_PCT = 0.08;
const ROI_PCT = 0.5;
const WEIGHT_BPS = 1000; // 10% of equity per position
const DD_HALT = 0.1;
const DD_EXIT = 0.15;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: seeded on the first close it sees, then the usual 2 / (span + 1) step. */
interface Ema {
  span: number;
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  long: Ema;
  closes: number[];
  trs: number[];
  prevClose: number | null;
  /** fast - slow after the symbol's previous bar, once both EMAs are set. */
  prevGap: number | null;
  /** Highest close since the current position was opened (0 when flat). */
  high: number;
  /** Bar index of the first entry tranche, or -1 when no second tranche is due. */
  scaleDue: number;
}

const series = new Map<string, Series>();

/** Peak equity so far, tracked across batches for the drawdown guard. */
let peakEquity = 0n;

function emaStep(e: Ema, close: number): void {
  if (e.value === null) {
    e.value = close;
    return;
  }
  e.value += (2 / (e.span + 1)) * (close - e.value);
}

function gapOf(s: Series): number | null {
  if (s.fast.value === null || s.slow.value === null) return null;
  return s.fast.value - s.slow.value;
}

function atrOf(s: Series): number {
  if (s.trs.length < ATR_SPAN) return NaN;
  let sum = 0;
  for (let i = s.trs.length - ATR_SPAN; i < s.trs.length; i++) sum += s.trs[i];
  return sum / ATR_SPAN;
}

/** Fold one bar in, remembering the gap from before this bar for cross detection. */
function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, value: null },
      slow: { span: SLOW_SPAN, value: null },
      long: { span: LONG_SPAN, value: null },
      closes: [],
      trs: [],
      prevClose: null,
      prevGap: null,
      high: 0,
      scaleDue: -1,
    };
    series.set(bar.symbol, s);
  }
  s.prevGap = gapOf(s);
  const close = Number(bar.c);
  const high = Number(bar.h);
  const low = Number(bar.l);
  emaStep(s.fast, close);
  emaStep(s.slow, close);
  emaStep(s.long, close);
  s.closes.push(close);
  const tr = s.prevClose === null ? high - low : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
  s.prevClose = close;
  s.trs.push(tr);
  return s;
}

/** A fraction of a 10%-of-equity stake, capped at the weight cap's room. */
function stakeFor(state: BarsState, symbol: string, fracNum: number, fracDen: number): bigint {
  const full = (BigInt(WEIGHT_BPS) * state.equity) / BPS;
  const byWeight = state.weightRoom(symbol);
  const stake = full < byWeight ? full : byWeight;
  return (stake * BigInt(fracNum)) / BigInt(fracDen);
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.equity > peakEquity) peakEquity = state.equity;
    const seen = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      seen.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const dd = peakEquity > 0n ? Number(peakEquity - state.equity) / Number(peakEquity) : 0;

    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];
    let cash = state.cash; // sells never fund a buy of the same reply
    let room = caps.max_open_positions - state.positions.size;

    for (const { symbol } of state.hello.symbols) {
      if (!seen.has(symbol)) continue;
      const s = series.get(symbol)!;
      const gap = gapOf(s);
      const prevGap = s.prevGap;
      const close = s.closes[s.closes.length - 1];
      const held = state.positions.get(symbol);
      const idx = s.closes.length - 1;

      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const cost = held.cost;
        const atr = atrOf(s);
        if (close > s.high) s.high = close;
        const exit =
          (prevGap !== null && gap !== null && gap < 0 && prevGap >= 0) ||
          (s.long.value !== null && close < s.long.value) ||
          value * 1000n <= cost * 920n ||
          value * 1000n >= cost * 1500n ||
          (Number.isFinite(atr) && close < s.high - TRAIL_ATR * atr) ||
          dd >= DD_EXIT;
        if (exit) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.high = 0;
          s.scaleDue = -1;
        } else if (s.scaleDue >= 0 && idx - s.scaleDue >= SCALE_IN_BARS) {
          // Second tranche: the trend still holds two bars after the first.
          s.scaleDue = -1;
          if (gap !== null && gap > 0 && (s.long.value === null || close >= s.long.value) && dd < DD_HALT) {
            const stake = stakeFor(state, symbol, 1, 2);
            if (stake >= minNotional && stake <= cash) {
              buys.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
              cash -= stake;
            }
          }
        }
        continue;
      }

      // Flat: enter only on a fresh cross-up with trend and momentum behind it.
      if (idx + 1 < MIN_BARS || dd >= DD_HALT || room <= 0) continue;
      if (prevGap === null || gap === null || gap <= 0 || prevGap > 0) continue;
      if (s.long.value !== null && close < s.long.value) continue;
      if (s.closes.length > MOMENTUM_BARS && close <= s.closes[s.closes.length - 1 - MOMENTUM_BARS]) continue;
      const stake = stakeFor(state, symbol, 1, 2);
      if (stake < minNotional || stake > cash) continue;
      buys.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= stake;
      room--;
      s.high = close;
      s.scaleDue = idx;
    }

    return [...sells, ...buys].slice(0, caps.max_orders_per_bar);
  },
});
