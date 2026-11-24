// main.ts — entrypoint: "Ride the runner, cut the rug".
//
// Wiring only: the hello handshake, the per-batch slot loop and the orders
// live in shim.ts; the trading decisions live in strategy.ts. On every batch
// the bot answers with one reply carrying that batch of orders (exits first,
// then entries), echoing the batch seq. Diagnostics go to stderr so stdout
// carries replies only.
//
// Run by the grader as `node main.ts` (Node 22 strips the types; no build,
// no install). Deterministic: no clock, no Math.random — the orders depend
// only on the slot, the reserves and the trade flow the harness reports.

import { runBot } from './shim.ts';
import { Strategy } from './strategy.ts';

const strategy = new Strategy();

await runBot({
  onHello(state) {
    const { capital, caps, latency_slots } = state.hello;
    console.error(
      `hello: capital ${(BigInt(capital.lamports) / 1_000_000_000n).toString()} SOL, ` +
        `max ${caps.max_open_positions} positions, max ${caps.max_orders_per_batch} orders/batch, ` +
        `latency ${latency_slots} slots`,
    );
  },
  onBatch(state, batch) {
    return strategy.decide(state, batch);
  },
  onDone(state) {
    console.error(
      `done: batches answered, round trips ${strategy.roundTrips}, ` +
        `distinct coins entered ${strategy.entered.size}, ` +
        `cash ${(state.cash / 1_000_000_000n).toString()} SOL`,
    );
  },
});
