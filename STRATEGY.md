# STRATEGY.md — Ride the Runner, Cut the Rug

## The bet

Pump.fun coins are a lottery with a visible tell: a coin that runs 2x off a
fresh low, on buy-dominated flow, is more likely to be a real runner than a
coin picked at random — and a coin that does not run is most likely going to
zero. So: pay a small, capped price to find out (0.08 SOL, stop-loss −10%),
and let the winners run to a trailing stop. The guardrails (≥20 coins, round
trip ≥0.01 SOL) are cleared by construction: the stake is 0.08 SOL and the bot
rotates through dozens of coins per window.

## What the dev dataset says (measured, not guessed)

The dev window holds 1,222 coins and 35 completions over 24 hours. The
median coin peaks at 1.24x its creation price, so buying coins at random
loses; the price multiple is capped at ~14.7x (the completion price, a fixed
function of the bonding curve: price ∝ (30 + real SOL)²). Of the coins that
reach 50 SOL of real reserves 62% complete — but they jump from below 50 to
85 SOL in a single trade, so by the time 50 SOL is observed the coin has
already completed (no upside left) or is about to dump. At 20 SOL of real
reserves 21.5% complete, the median coin still runs +59% after first touching
20 SOL — but the median coin also eventually falls to 36% of its entry price,
so the exit, not the entry, decides whether the trade makes money.

## What was tried (all graded on the dev window with grade-local)

Nine variants, one exit engine at a time where noted. Net PnL in lamports
and SOL; the shipped variant is momentum v3.

| Variant | Net PnL (lamports) | Net PnL (SOL) | Max DD | Coins | Fills | Win rate | Top-3 share | PnL ex top-3 (SOL) |
|---|---|---|---|---|---|---|---|---|
| Momentum v1 (TP +60%, SL −18%) | −1,236,985,972 | −1.237 | 14.07% | 215 | 430 | 30.2% | 11% | −1.49 |
| Momentum v2 (no TP, trail, SL −12%) | −1,039,961,880 | −1.040 | 12.54% | 215 | 428 | 16.7% | 37% | −1.45 |
| **Momentum v3 (shipped)** | **−314,208,837** | **−0.314** | **4.95%** | **93** | **184** | **21.5%** | **47%** | **−0.74** |
| Momentum v4 (tighter entry) | −161,707,585 | −0.162 | 1.67% | 20 | 40 | 15.0% | 100% | −0.17 |
| Dip (buy the bounce) | −1,062,132,779 | −1.062 | 10.85% | 201 | 402 | 20.4% | 25% | −1.36 |
| Sniper (buy every young coin) | −3,648,536,292 | −3.649 | 37.34% | 627 | 1,254 | 21.7% | 9% | −3.97 |
| Two-tier v5 (completer hunters, 0.20 SOL) | −3,286,856,021 | −3.287 | 32.87% | 140 | 283 | 25.0% | 48% | −4.15 |
| Two-tier v6 (v5 + TP 3x, SL −5%) | −2,266,445,778 | −2.266 | 24.81% | 140 | 282 | 9.3% | 43% | −3.52 |
| v7 (v3 entry + TP 3x, SL −5%) | −526,289,113 | −0.526 | 5.64% | 93 | 186 | 6.5% | 99% | −1.02 |
| House equal-weight baseline | −22,829,110 | −0.023 | 0.96% | 5 | 5 | 0.0% | — | — |

Fees on the shipped variant: 0.182 SOL curve + 0.020 SOL tx; at 2x fees the
net PnL is −0.511 SOL. Determinism: every grade reports "L1 regrade
reproduced byte for byte".

## What shipped and why

Momentum v3 ships because it is the least-negative variant that still trades
enough coins for the guardrails on a 6-hour final window. The dev window is
24 hours; v3's 93 coins a day is ~23 on the final, v4's 20 a day is ~5 and
would fail the 20-coin bar outright. v3's 90% interval (−0.85..+0.25 SOL) is
also the only one that reaches positive territory.

## Why the simulation did not survive contact with the protocol

An offline simulation over the dev window's price paths said TP 3x / SL −5%
should earn +0.23 SOL per entry (the typical loser eventually falls −64%,
so cutting at −5% and letting winners run to +200% looks like free money).
The real bot earns nothing like it (v6: −2.266 SOL; v7: −0.526 SOL), for two
protocol reasons the simulation ignores: orders decided on slot s fill at
slot s+2, so a −5% stop decision fills deep into the dump (~−23% realized),
and the bot decides once per batch, so intra-slot spikes to the take-profit
level are gone by the time the sell fills. The tighter the stop, the worse
the latency hurts — v7's win rate collapsed to 6.5% because the −5% stop
fires on noise constantly. Exits must be wide enough to survive 2 slots of
adverse drift, which is why v3's −10% stop plus a 25% trailing pullback beats
both the −5% stop and the +60% take-profit cap.

## Stress (grade-local --stress, rebuilt copies of the dev window)

10 block surrogates, run on the submitted commit (`--stress 10
--stress-jobs 2`): **median −0.50 SOL, p10 −0.66, p90 −0.22 SOL; 9 of 10
copies lost money**; the dev score (−0.314 SOL) sits above 7 of 10. Per-copy
net PnL (SOL): −0.22, −0.51, −0.51, −0.41, −0.50, +0.02, −0.29, −0.66,
−0.53, −0.50. Only one copy (blocks-06) made money, and only +0.02 SOL.
The kit's own warning fired: "half or more of the rebuilt copies lost
money". The dev result is not a fluke of one window's coins — the strategy
loses on nearly every rebuilt window, including its 90th percentile.

## Risks, stated plainly

- **No variant beats hold cash on the dev window.** The shipped entry is the
  best of a losing set. On the final 6-hour window it can still win if the
  fresh coins run better than the dev window's — but nothing in the dev
  numbers proves that; the 90% interval straddles zero.
- **Guardrail risk on the final window.** v3 trades ~23 coins per 6 hours at
  the dev rate, uncomfortably close to the 20-coin bar. A quiet final window
  could push it under.
- **Concentration.** 47% of v3's gains come from its top 3 coins; without
  them the net PnL is −0.74 SOL. The result leans on a few runners.
- **Fees.** A round trip costs ~1.25% of the trade each way plus 105,000
  lamports per order, so the strategy needs roughly +3% per trade just to
  break even — on a market where the median coin peaks at +24%.
