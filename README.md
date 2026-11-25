# Tiny Trend Bot

[![bounty](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Nghyuu/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Nghyuu/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) — a bars-replay/v1 entry that trades hourly Solana bars and aims to beat buy-and-hold on net PnL.

## Strategy

Multi-asset EMA-crossover momentum with a volatility filter, written from scratch:

- **Entry:** EMA(8) crosses above EMA(21), the close sits above EMA(30), and 12-hour momentum is positive. Entries are staged — half the stake on the cross, the other half two bars later if the trend still holds.
- **Exit:** EMA(8) crosses back under EMA(21), the close falls under EMA(30), an ATR(14) trailing stop (1.5x), an 8% stop-loss, or a 50% take-profit.
- **Sizing:** 10% of equity per position (under the 25% weight cap), one position per symbol.
- **Guard:** no new entries once equity is 10% under its peak; exit everything at 15% under the peak.

Deterministic (no clock, no randomness, no network); the same bars always produce the same orders.

## Dev result

Graded locally on the kit's dev window (136 hourly bars):

- **Net PnL −$40.83** vs buy-and-hold **−$869.34** — beats the baseline by about **+$828.50**
- 18 trades over 7 symbols, max drawdown 0.67%, guardrails met

## Layout

- `main.ts` — the bot (Node 22 TypeScript, stdlib + the vendored SDK)
- `vendor/makefun-bars.ts` — the kit's bars-replay/v1 SDK, vendored unchanged
- `.makefun/owner.json` — the entry's payout wallet
