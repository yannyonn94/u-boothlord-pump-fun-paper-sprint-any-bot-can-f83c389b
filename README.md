# Ride the Runner, Cut the Rug — Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yannyonn94/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yannyonn94/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

**Concept in one line:** buy only coins that already proved they can run — up 2x off a fresh low, still climbing near their highs on buy-dominated flow — then exit on a trailing stop, a hard stop, or a dead-coin exit, so the few coins that run pay for the many that do not.

## Why this shape

On pump.fun most coins die within minutes of creation. Buying every coin (the house equal-weight baseline) bleeds on the 95% that go to zero, and holding never sells the winners before they give it back. This bot is selective at entry and ruthless at exit: one capped loss per coin, no second chances, and a hard time stop so capital keeps rotating through new coins.

## Strategy (shipped: selective momentum)

- **Entry:** a coin must be up ≥2x from the lowest price seen since its creation, with that low less than 1,800 slots old, still climbing ≥8% over the last 300 slots, sitting within 20% of its peak, and with buy flow beating sell flow 1.5x over the last 600 slots. Young coins only (≤14,400 slots old), real reserves ≥2 SOL.
- **Stake:** 0.08 SOL per coin, never more than the per-mint size cap (100 bps of real SOL reserve), never less than 0.02 SOL — every round trip clears the 0.01 SOL guardrail bar with room.
- **Exits (all sell the full position):** no fixed take-profit — a trailing stop takes winners instead (once up 50%, sell on a 25% pullback from the peak); stop-loss at −10% of the fill price; dead-coin exit (no run 10% above entry after 900 slots); hard time stop after 7,200 slots (~48 min).
- **Limits respected:** max 5 open positions, max 16 orders per batch, no shorts, no leverage. Latency is 2 slots; buy slippage 500 bps, sell slippage 1000 bps so exits execute even in a dump.

## Dev-window results (grade-local, process driver, 24 h window)

| Variant | Net PnL (SOL) | Max drawdown | Distinct mints | Fills | Win rate |
|---|---|---|---|---|---|
| Momentum v3 (shipped) | −0.314 | 4.95% | 93 | 184 | 21.5% |
| Momentum v4 (tighter entry) | −0.162 | 1.67% | 20 | 40 | 15.0% |
| Momentum v1 | −1.237 | 14.07% | 215 | 430 | 30.2% |
| Momentum v2 | −1.040 | 12.54% | 215 | 428 | 16.7% |
| v7 (v3 entry + TP 3x / SL −5%) | −0.526 | 5.64% | 93 | 186 | 6.5% |
| Dip (buy-the-bounce) | −1.062 | 10.85% | 201 | 402 | 20.4% |
| Sniper (buy every young coin) | −3.649 | 37.34% | 627 | 1,254 | 21.7% |
| Two-tier v5 (completer hunters) | −3.287 | 32.87% | 140 | 283 | 25.0% |
| Two-tier v6 (v5 + TP 3x / SL −5%) | −2.266 | 24.81% | 140 | 282 | 9.3% |
| House equal-weight baseline | −0.023 | 0.96% | 5 | 5 | 0.0% |

Guardrails: ≥20 distinct coins with a round trip ≥0.01 SOL each, max drawdown ≤50%. The shipped variant meets them (93 coins, 4.95% drawdown). Its 90% interval is −0.85..+0.25 SOL.

**Honest note:** no tested variant beats hold cash (0 SOL) on the dev window — the shipped entry is the least-negative variant that still trades enough coins for the guardrails on a 6-hour final window (v4 is less negative but trades only 20 coins a day, ~5 on the final, and would fail the 20-coin bar). See STRATEGY.md for the full analysis, including why an offline simulation's +0.23 SOL/entry did not survive the protocol's 2-slot fill latency.

## Files

- `main.ts` — entrypoint (Node 22, no build step): wires the shim to the strategy.
- `strategy.ts` — the trading logic: per-coin price/flow tracking, the momentum entry rule, shared exits.
- `shim.ts` — a small original implementation of the agent-fun/replay/v2 wire protocol (NDJSON hello/batch/done on stdin/stdout, one reply per batch), written from the kit's published protocol schema.
- `STRATEGY.md` — the strategy note: what was tried, what the numbers said, what shipped, and the risks.

## Determinism

No clock, no `Math.random`, no environment reads anywhere in the trading path. Orders depend only on the slot number, the reserves the harness reports, and the trade flow in the batches — so the two grading executions produce byte-identical action logs (grade-local reports "L1 regrade reproduced byte for byte").

## License

MIT — see [LICENSE](LICENSE).
