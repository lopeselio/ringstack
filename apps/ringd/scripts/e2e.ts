/**
 * Localnet run of ringd against a merchant it holds only read-only keys for.
 *   1. A payment lands before ringd starts → reported once, marked backfill.
 *   2. A live payment with an order memo → payment.received with the memo.
 *   3. Idle cycle and a restart on the same database → no duplicates.
 *   4. The merchant spends (elsewhere, with its spending key) → payment.sent,
 *      detected via the nullifier key alone.
 *
 *   pnpm --filter @ringstack/ringd e2e
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { RingSession, clientConfigFromEnv, encodeMemo } from "@ringstack/core";
import { lamports } from "@solana/kit";

import { Daemon, type Logger } from "../src/daemon.ts";
import { exportKeyFile } from "../src/keyfile.ts";
import { RingdStore, type StoredEvent } from "../src/store.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const quiet: Logger = { info: () => {}, error: (m, f) => console.error(m, f) };
const clientConfig = clientConfigFromEnv();

await initializePoseidon();
const client = await createZolanaClient(clientConfig);
const customer = await RingSession.open(client, ShieldedKeypair.generate());
const merchant = await RingSession.open(client, ShieldedKeypair.generate());
for (const s of [customer, merchant]) {
  await client.confirmTransaction(await client.solanaRpc.requestAirdrop(s.owner, lamports(1_000_000_000n)).send());
  await s.register();
}
await customer.deposit(50_000_000n);

// 1. Paid before ringd exists.
await customer.transfer(merchant.owner, 7_000_000n, { memo: encodeMemo("order:early") });

const dir = mkdtempSync(join(tmpdir(), "ringd-e2e-"));
const keyFile = join(dir, "shop.json");
writeFileSync(keyFile, exportKeyFile(merchant.keypair), { mode: 0o600 });
const dbPath = join(dir, "ringd.db");

async function startDaemon() {
  const store = new RingdStore(dbPath);
  const daemon = new Daemon({
    client: clientConfig,
    wallets: [{ name: "shop", keyFile }],
    store,
    pollIntervalMs: 1000,
    log: quiet,
  });
  await daemon.start();
  return { store, daemon };
}

const first = (es: StoredEvent[]): StoredEvent["event"] | undefined => es[0]?.event;
const show = (es: StoredEvent[]) =>
  es.map((e) => `${e.event.type} ${e.event.amount}${e.event.memo ? ` memo=${e.event.memo}` : ""}${e.event.backfill ? " (backfill)" : ""}`);

let { store, daemon } = await startDaemon();
let added = await daemon.runOnce();
console.log("first sync     ", show(added));
check(added.length === 1, `expected 1 backfill event, got ${added.length}`);
check(first(added)?.type === "payment.received" && first(added)?.amount === "7000000", "backfill payment");
check(first(added)?.memo === "order:early" && first(added)?.backfill === true, "backfill memo/flag");

// 2. Live payment.
await customer.transfer(merchant.owner, 3_000_000n, { memo: encodeMemo("order:1042") });
added = await daemon.runOnce();
console.log("live payment   ", show(added));
check(added.length === 1 && first(added)?.memo === "order:1042" && first(added)?.backfill === false, "live payment event");

// 3. Idle cycle, then restart on the same database.
check((await daemon.runOnce()).length === 0, "idle cycle should add nothing");
store.close();
({ store, daemon } = await startDaemon());
added = await daemon.runOnce();
console.log("after restart  ", show(added));
check(added.length === 0, "restart re-emitted events");
check(store.listEvents().length === 2, "expected 2 stored events");

// 4. The merchant spends with its own wallet; ringd sees it with read-only keys.
await merchant.sync();
await merchant.transfer(customer.owner, 1_000_000n);
added = await daemon.runOnce();
console.log("merchant spend ", show(added));
check(added.some((e) => e.event.type === "payment.sent"), "expected a payment.sent event");
store.close();

console.log("ok: ringd backfill, live memo, restart idempotency, read-only spend detection");
