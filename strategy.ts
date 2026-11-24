// strategy.ts — "Selective momentum, hard exits": a single-tier pump.fun bot.
//
// Concept (one line): buy only coins that already proved they can run — up
// 2x off a fresh low, still climbing near their highs on buy-dominated flow —
// then exit on a trailing stop (after +50%, sell on a 25% pullback), a hard
// stop at -10%, or a dead-coin exit, so the few coins that run pay for the
// many that do not.
//
// What nine graded variants proved, in order (grade-local, dev window):
//   momentum v1 (TP +60%, SL -18%)          -1.237 SOL, 215 coins
//   momentum v2 (no TP, trail, SL -12%)     -1.040 SOL, 215 coins
//   momentum v3 (v2 + stricter, fresher)    -0.314 SOL,  93 coins  <-- SHIPPED
//   momentum v4 (v3 + tighter still)        -0.162 SOL,  20 coins
//   dip (buy the bounce)                    ~-1.05  SOL, 201 coins
//   sniper (buy every young coin)           -3.649 SOL, 627 coins
//   two-tier v5 (completer hunters 0.20)    -3.287 SOL, 140 coins
//   two-tier v6 (v5 + TP 3x, SL -5%)        -2.266 SOL, 140 coins
//   v7 (v3 entry + TP 3x, SL -5%)           -0.526 SOL,  93 coins
// The pattern: selectivity helps (every stricter momentum filter lost less),
// buying everything loses the most, and big stakes on late "completer"
// entries lose the most per coin — a coin that already holds 20 SOL of real
// reserves usually dumps right after entry, and the 2-slot fill latency turns
// a -5% stop into a ~-23% realized loss. An offline simulation over the dev
// window's price paths said TP 3x / SL -5% should earn +0.23 SOL per entry;
// the real bot earns nothing like it, because the simulation fills instantly
// at the stop level while the protocol fills 2 slots later, after the dump.
// v3 ships because it is the least-negative variant that still trades enough
// coins for the guardrails on a 6-hour final window (93 coins a day here is
// ~23 on the final; v4's 20 a day would be ~5 and fail the 20-coin bar), and
// its 90% interval (-0.85..+0.25 SOL) is the only one that reaches positive
// territory. No variant beats hold cash (0 SOL) on the dev window; that is
// reported as-is in STRATEGY.md and in the build report — this entry is the
// best of a losing set, not a proven winner.
//
// Guardrails: the stake is 0.08 SOL, so every round trip clears the 0.01 SOL
// bar with room; the entry trades several dozen coins a day, which is what
// the 20-coin guardrail needs on a 6-hour final window (the dev window is
// 24 hours; v4's 20 coins a day would be ~5 on the final and fail it).
//
// Everything here is deterministic: decisions use only the slot number, the
// reserves the harness reports, and the trade flow in the batches. No clock,
// no Math.random, no environment. Two executions of the same run therefore
// produce byte-identical orders.

import type { Batch, BotState, Curve, OrderInput, Pubkey } from './shim.ts';
import { curvePrice } from './shim.ts';

// ------------------------------------------------------------------ tuning

/** SOL to spend per buy (0.08 SOL); never more than the per-mint size cap. */
const STAKE_LAMPORTS = 80_000_000n;
/** Smallest buy worth sending: must clear the 0.01 SOL round-trip bar with room. */
const MIN_BUY_LAMPORTS = 20_000_000n;
/** A coin only counts once its real SOL reserve lets the cap reach MIN_BUY. */
const MIN_REAL_QUOTE_LAMPORTS = 2_000_000_000n;

/** Entry: price must be this far above the lowest price seen since creation. */
const MOM_RISE_FROM_TROUGH = 2.0;
/** Entry: price must still be climbing this much over the last LOOKBACK slots. */
const MOM_STILL_CLIMBING = 1.08;
const LOOKBACK_SLOTS = 300;
/** Entry: the trough the rise started from must be this recent (a stale pump
 *  from hours ago is not a runner, it is a top). */
const MOM_FRESH_SLOTS = 1_800;
/** Entry: price must still sit this close to its peak (buy strength, not a
 *  coin already sliding off its high). */
const MOM_NEAR_PEAK = 0.8;
/** Entry: buy flow must beat sell flow by this factor over FLOW_WINDOW slots. */
const MOM_FLOW_RATIO = 1.5;
/** Oldest coin (slots since creation) an entry will touch. */
const MAX_ENTRY_AGE_SLOTS = 14_400;

/** Exit: no fixed take-profit — a trailing stop takes winners instead, so a
 *  runner is never capped (v1's +60% cap cost the tail). Once up 50%, trail
 *  the peak and sell on a 25% pullback. */
const TRAIL_ARM_X = 1.5;
const TRAIL_PULLBACK = 0.75;
/** Exit: hard stop-loss, as a fraction of the fill price. */
const STOP_LOSS_X = 0.9;
/** Exit: a coin that has not run this far above entry after this many slots
 *  is dead money — sell it and free the slot for a fresh coin. */
const DEAD_EXIT_SLOTS = 900;
const DEAD_EXIT_X = 1.1;
/** Exit: sell everything after holding this many slots (~48 min). */
const MAX_HOLD_SLOTS = 7_200;
/** Trade flow is summed over this many recent slots. */
const FLOW_WINDOW_SLOTS = 600;

/** Buy slippage allowance (bps): wide enough that a fast runner still fills. */
const BUY_SLIPPAGE_BPS = 500;
/** Sell slippage allowance (bps): exits must execute, even in a dump. */
const SELL_SLIPPAGE_BPS = 1000;
/** Keep at most this many price samples per coin (a ring, oldest dropped). */
const MAX_SAMPLES = 96;

// ------------------------------------------------------------------ tracking

interface PriceSample {
  slot: number;
  price: number;
}

interface FlowSample {
  slot: number;
  buySol: number;
  sellSol: number;
}

interface CoinTrack {
  firstSlot: number;
  createdSlot: number | null;
  trough: number;
  troughSlot: number;
  peak: number;
  peakSlot: number;
  samples: PriceSample[];
  flow: FlowSample[];
}

interface EntryInfo {
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
}

export class Strategy {
  /** Per-mint history, for coins seen this run. */
  readonly tracks = new Map<Pubkey, CoinTrack>();
  /** Mints with a buy already filled: never bought twice. */
  readonly entered = new Set<Pubkey>();
  /** Mints with a buy decided but not yet resolved. */
  readonly pendingBuy = new Set<Pubkey>();
  /** Mints with a sell decided but not yet resolved. */
  readonly pendingSell = new Set<Pubkey>();
  /** Entry price / peak per held mint, from its buy fill. */
  readonly entries = new Map<Pubkey, EntryInfo>();
  /** Round trips completed (buy fill + sell fill), for stderr reporting only. */
  roundTrips = 0;

  /** Fold one batch's fills into the entry bookkeeping. */
  noteFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        this.pendingBuy.delete(f.mint);
        if (f.status === 'filled') {
          this.entered.add(f.mint);
          const spent = Number(BigInt(f.quote_lamports));
          const got = Number(BigInt(f.token_amount));
          if (spent > 0 && got > 0) {
            const price = spent / got;
            this.entries.set(f.mint, { entryPrice: price, entrySlot: f.slot, peakPrice: price });
          }
        }
      } else {
        this.pendingSell.delete(f.mint);
        if (f.status === 'filled' && this.entered.has(f.mint)) this.roundTrips += 1;
      }
    }
  }

  /** Record this batch's price samples and trade flow for the mints it touched. */
  observe(state: BotState, batch: Batch): void {
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      touched.add(e.mint);
      if (e.event === 'TradeEvent') {
        const t = this.track(e.mint, batch.slot, state.curves.get(e.mint)?.created_slot ?? null);
        const sol = Number(BigInt(e.sol_amount)) / 1_000_000_000;
        const last = t.flow[t.flow.length - 1];
        if (last !== undefined && last.slot === batch.slot) {
          if (e.is_buy) last.buySol += sol;
          else last.sellSol += sol;
        } else {
          t.flow.push({ slot: batch.slot, buySol: e.is_buy ? sol : 0, sellSol: e.is_buy ? 0 : sol });
          if (t.flow.length > 200) t.flow.shift();
        }
      }
    }
    for (const m of batch.marks) touched.add(m.mint);
    for (const mint of state.positions.keys()) touched.add(mint);
    for (const mint of touched) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve);
      if (!(price > 0)) continue;
      const t = this.track(mint, batch.slot, curve.created_slot);
      const last = t.samples[t.samples.length - 1];
      if (last !== undefined && last.slot === batch.slot) {
        last.price = price;
      } else {
        t.samples.push({ slot: batch.slot, price });
        if (t.samples.length > MAX_SAMPLES) t.samples.shift();
      }
      if (price < t.trough) {
        t.trough = price;
        t.troughSlot = batch.slot;
      }
      if (price > t.peak) {
        t.peak = price;
        t.peakSlot = batch.slot;
      }
    }
    // Forget coins whose curve completed and we never entered: dead weight.
    for (const [mint, curve] of state.curves) {
      if (curve.complete && !this.entered.has(mint) && !state.positions.has(mint)) {
        this.tracks.delete(mint);
      }
    }
  }

  track(mint: Pubkey, slot: number, createdSlot: number | null): CoinTrack {
    let t = this.tracks.get(mint);
    if (t === undefined) {
      t = { firstSlot: slot, createdSlot, trough: Infinity, troughSlot: slot, peak: 0, peakSlot: slot, samples: [], flow: [] };
      this.tracks.set(mint, t);
    }
    if (t.createdSlot === null && createdSlot !== null) t.createdSlot = createdSlot;
    return t;
  }

  /** Price of a mint LOOKBACK slots ago, from its samples (0 when unknown). */
  priceAgo(t: CoinTrack, nowSlot: number, ago: number): number {
    const target = nowSlot - ago;
    let best = 0;
    for (let i = t.samples.length - 1; i >= 0; i--) {
      if (t.samples[i].slot <= target) {
        best = t.samples[i].price;
        break;
      }
    }
    return best;
  }

  /** Buy vs sell SOL flow over the recent window, as [buy, sell]. */
  flowWindow(t: CoinTrack, nowSlot: number): [number, number] {
    let buy = 0;
    let sell = 0;
    const from = nowSlot - FLOW_WINDOW_SLOTS;
    for (const f of t.flow) {
      if (f.slot < from) continue;
      buy += f.buySol;
      sell += f.sellSol;
    }
    return [buy, sell];
  }

  /** Entry signal: up 2x from a fresh trough, still climbing near its peak. */
  entrySignal(state: BotState, mint: Pubkey, curve: Curve, price: number): boolean {
    const t = this.tracks.get(mint);
    if (t === undefined) return false;
    const created = t.createdSlot ?? t.firstSlot;
    const age = state.slot - created;
    if (age > MAX_ENTRY_AGE_SLOTS) return false;
    if (curve.real_quote_reserves < MIN_REAL_QUOTE_LAMPORTS) return false;
    if (t.trough === Infinity || t.peak <= 0) return false;
    if (price < t.trough * MOM_RISE_FROM_TROUGH) return false;
    if (state.slot - t.troughSlot > MOM_FRESH_SLOTS) return false;
    if (price < t.peak * MOM_NEAR_PEAK) return false;
    const ago = this.priceAgo(t, state.slot, LOOKBACK_SLOTS);
    if (ago > 0 && price < ago * MOM_STILL_CLIMBING) return false;
    const [buy, sell] = this.flowWindow(t, state.slot);
    if (buy < sell * MOM_FLOW_RATIO) return false;
    return true;
  }

  /** The orders for this batch: exits first, then entries, at most 16. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.noteFills(batch);
    this.observe(state, batch);
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // --- exits: every held mint is judged against its fill price.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (this.pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = this.entries.get(mint);
      const price = curvePrice(curve);
      if (!(price > 0)) continue;
      let sell = false;
      if (info !== undefined) {
        const held = state.slot - info.entrySlot;
        if (price <= info.entryPrice * STOP_LOSS_X) sell = true;
        else if (held >= MAX_HOLD_SLOTS) sell = true;
        // No fixed take-profit: the trailing stop below is the only way a
        // winner leaves, so a 5-10x runner is never capped at +60%.
        else if (held >= DEAD_EXIT_SLOTS && price < info.entryPrice * DEAD_EXIT_X) sell = true;
        else {
          if (price > info.peakPrice) info.peakPrice = price;
          if (info.peakPrice >= info.entryPrice * TRAIL_ARM_X && price <= info.peakPrice * TRAIL_PULLBACK) sell = true;
        }
      } else {
        // Held without a recorded fill (should not happen): time-box it by age.
        const t = this.tracks.get(mint);
        if (t !== undefined && state.slot - t.firstSlot >= MAX_HOLD_SLOTS) sell = true;
      }
      if (!sell) continue;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      this.pendingSell.add(mint);
    }

    // --- entries: coins this batch touched, in event order, one buy each.
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      if (orders.length >= maxOrders || slots <= 0) break;
      const mint = e.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (this.entered.has(mint) || this.pendingBuy.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve);
      if (!(price > 0)) continue;
      if (!this.entrySignal(state, mint, curve, price)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      this.pendingBuy.add(mint);
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  }
}
