/**
 * Localnet run of ringd against a merchant it holds only read-only keys for,
 * delivering to a local webhook receiver that verifies every request.
 *   1. A payment lands before ringd starts → reported once, marked backfill.
 *   2. A live payment with an order memo → payment.received with the memo.
 *   3. Idle cycle and a restart on the same database → no duplicates.
 *   4. The merchant spends (elsewhere, with its spending key) → payment.sent,
 *      detected via the nullifier key alone.
 * Webhooks:
 *   orders  payment.received only; fails its first 2 requests (retries, same ringd-id)
 *   all     every event
 *   dead    unreachable; deliveries end up failed, then `retryFailed` requeues them
 * Auto-merge:
 *   kiosk   owner opted in to merges; after 3 memo payments ringd merges them with
 *           the key file + a separate fee payer (owner pays nothing, signs nothing)
 *   shop    has a threshold but never opted in; ringd logs once and skips it
 *
 *   pnpm --filter @ringstack/ringd e2e
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOL_MINT, ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { RingSession, clientConfigFromEnv, encodeMemo, loadShieldedKeypair } from "@ringstack/core";
import { verifyWebhook, type RingdEvent } from "@ringstack/ringd-client";
import { lamports } from "@solana/kit";

import type { DeliveryConfig, WebhookConfig } from "../src/config.ts";
import { Daemon, type Logger } from "../src/daemon.ts";
import { exportKeyFile } from "../src/keyfile.ts";
import { RingdStore, type StoredEvent } from "../src/store.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// --- webhook receiver -------------------------------------------------------
const SECRET = "whsec_e2e_0123456789abcdef";
const received = new Map<string, { hook: string; event: RingdEvent }[]>(); // hook → accepted
const seenIds = new Map<string, number>(); // `${hook} ${ringd-id}` → requests (incl. rejected)
let ordersFailuresLeft = 2;
let badSignatures = 0;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const hook = (req.url ?? "/").slice(1);
    const body = Buffer.concat(chunks).toString("utf8");
    let verified;
    try {
      verified = verifyWebhook({ body, headers: req.headers, secret: SECRET });
    } catch {
      badSignatures++;
      res.writeHead(400).end();
      return;
    }
    const key = `${hook} ${verified.id}`;
    seenIds.set(key, (seenIds.get(key) ?? 0) + 1);
    if (hook === "orders" && ordersFailuresLeft > 0) {
      ordersFailuresLeft--;
      res.writeHead(500).end();
      return;
    }
    // Idempotent receiver: accept each ringd-id once.
    const list = received.get(hook) ?? [];
    if (!list.some((r) => `${r.event.wallet}:${r.event.id}` === verified.id)) list.push({ hook, event: verified.event });
    received.set(hook, list);
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const webhooks: WebhookConfig[] = [
  { name: "orders", url: `${base}/orders`, secret: SECRET, wallets: ["shop"], events: ["payment.received"] },
  { name: "all", url: `${base}/all`, secret: SECRET, wallets: ["shop"] },
  { name: "dead", url: "http://127.0.0.1:9/dead", secret: SECRET, wallets: ["shop"], events: ["payment.received"] },
];
const delivery: DeliveryConfig = { timeoutMs: 2000, maxAttempts: 3, retryBaseMs: 50, retryMaxMs: 200 };

// --- chain setup ------------------------------------------------------------
const errors: string[] = [];
const quiet: Logger = { info: () => {}, error: (m) => errors.push(m) };
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

// Kiosk: a second merchant that opts in to merges.
const kiosk = await RingSession.open(client, ShieldedKeypair.generate());
await client.confirmTransaction(await client.solanaRpc.requestAirdrop(kiosk.owner, lamports(1_000_000_000n)).send());
await kiosk.register();
await kiosk.setMerge(true);

// 1. Paid before ringd exists.
await customer.transfer(merchant.owner, 7_000_000n, { memo: encodeMemo("order:early") });

const dir = mkdtempSync(join(tmpdir(), "ringd-e2e-"));
const keyFile = join(dir, "shop.json");
writeFileSync(keyFile, exportKeyFile(merchant.keypair), { mode: 0o600 });
const dbPath = join(dir, "ringd.db");
const kioskKeyFile = join(dir, "kiosk.json");
writeFileSync(kioskKeyFile, exportKeyFile(kiosk.keypair), { mode: 0o600 });

// Fee payer for merges: its own keypair with SOL only.
const feePayerPath = join(dir, "fee-payer.json");
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  writeFileSync(feePayerPath, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
}
const feePayerAddress = (await loadShieldedKeypair(feePayerPath)).toSolanaSigner().address;
await client.confirmTransaction(await client.solanaRpc.requestAirdrop(feePayerAddress, lamports(100_000_000n)).send());

async function startDaemon() {
  const store = new RingdStore(dbPath);
  const daemon = new Daemon({
    client: clientConfig,
    wallets: [
      { name: "shop", keyFile, mergeThreshold: 2 },
      { name: "kiosk", keyFile: kioskKeyFile, mergeThreshold: 3 },
    ],
    store,
    pollIntervalMs: 1000,
    log: quiet,
    webhooks,
    delivery,
    merge: { feePayer: feePayerPath, maxInputs: 24 },
  });
  await daemon.start();
  return { store, daemon };
}

/** Run dispatch passes until nothing is pending (retries back off ~50–200 ms). */
async function drain(store: RingdStore, daemon: Daemon) {
  for (let i = 0; i < 100 && store.listDeliveries({ status: "pending" }).length > 0; i++) {
    await new Promise((r) => setTimeout(r, 60));
    await daemon.dispatch();
  }
  check(store.listDeliveries({ status: "pending" }).length === 0, "deliveries still pending");
}

const first = (es: StoredEvent[]): StoredEvent["event"] | undefined => es[0]?.event;
const show = (es: StoredEvent[]) =>
  es.map((e) => `${e.event.type} ${e.event.amount}${e.event.memo ? ` memo=${e.event.memo}` : ""}${e.event.backfill ? " (backfill)" : ""}`);

let { store, daemon } = await startDaemon();
let added = (await daemon.runOnce()).events;
console.log("first sync     ", show(added));
check(added.length === 1, `expected 1 backfill event, got ${added.length}`);
check(first(added)?.type === "payment.received" && first(added)?.amount === "7000000", "backfill payment");
check(first(added)?.memo === "order:early" && first(added)?.backfill === true, "backfill memo/flag");

// 2. Live payment.
await customer.transfer(merchant.owner, 3_000_000n, { memo: encodeMemo("order:1042") });
added = (await daemon.runOnce()).events;
console.log("live payment   ", show(added));
check(added.length === 1 && first(added)?.memo === "order:1042" && first(added)?.backfill === false, "live payment event");
await drain(store, daemon);

// 3. Idle cycle, then restart on the same database.
check((await daemon.runOnce()).events.length === 0, "idle cycle should add nothing");
store.close();
({ store, daemon } = await startDaemon());
added = (await daemon.runOnce()).events;
console.log("after restart  ", show(added));
check(added.length === 0, "restart re-emitted events");
check(store.listEvents({ wallet: "shop" }).length === 2, "expected 2 stored shop events");

// 4. The merchant spends with its own wallet; ringd sees it with read-only keys.
await merchant.sync();
await merchant.transfer(customer.owner, 1_000_000n);
added = (await daemon.runOnce()).events;
console.log("merchant spend ", show(added));
check(added.some((e) => e.event.type === "payment.sent"), "expected a payment.sent event");
await drain(store, daemon);

// 5. Auto-merge: three memo payments push the kiosk over its threshold.
for (const order of ["k1", "k2", "k3"]) {
  await customer.transfer(kiosk.owner, 1_000_000n, { memo: encodeMemo(`order:${order}`) });
}
const ownerLamportsBefore = (await client.solanaRpc.getBalance(kiosk.owner).send()).value;
added = (await daemon.runOnce()).events; // records the 3 payments, then merges
console.log("kiosk payments ", show(added));
check(added.filter((e) => e.event.wallet === "kiosk" && e.event.type === "payment.received").length === 3, "kiosk payments");
added = (await daemon.runOnce()).events; // the merge shows up in history
console.log("kiosk merge    ", show(added));
check(added.some((e) => e.event.wallet === "kiosk" && e.event.type === "utxo.merged"), "expected a utxo.merged event");
await kiosk.sync();
const kioskUtxos = kiosk.wallet.balance(SOL_MINT).utxos;
check(kioskUtxos.length === 1 && kioskUtxos[0]!.amount === 3_000_000n, `kiosk utxos ${kioskUtxos.map((u) => u.amount)}`);
check(kioskUtxos[0]!.data.isEmpty(), "merged output should be plain");
const ownerLamportsAfter = (await client.solanaRpc.getBalance(kiosk.owner).send()).value;
check(ownerLamportsAfter === ownerLamportsBefore, "the kiosk owner paid for the merge");
console.log("kiosk merged 3 memo payments into 1 plain UTXO; fee paid by the fee payer, not the owner");

// The shop is over its threshold of 2 but never opted in: skipped and logged once per
// daemon run (this test started two: before and after the restart), never merged.
check(errors.filter((m) => m.startsWith("merge skipped")).length === 2, `merge-skip logs: ${JSON.stringify(errors)}`);
check(!store.listEvents({ wallet: "shop" }).some((e) => e.event.type === "utxo.merged"), "shop must not be merged");
console.log("shop (no opt-in) was skipped, logged once per run");

// --- webhook assertions -----------------------------------------------------
const memos = (hook: string) => (received.get(hook) ?? []).map((r) => r.event.memo ?? r.event.type).sort();
console.log("webhook orders ", memos("orders"));
console.log("webhook all    ", memos("all"));
check(badSignatures === 0, `${badSignatures} requests failed signature verification`);
check(JSON.stringify(memos("orders")) === JSON.stringify(["order:1042", "order:early"]), "orders got the wrong events");
check(memos("all").length === 3 && memos("all").includes("payment.sent"), "all should get every event");

// The first orders delivery failed twice, then succeeded with the same ringd-id.
const ordersRows = store.listDeliveries({ webhook: "orders" });
check(ordersRows.every((d) => d.status === "delivered"), "orders deliveries not all delivered");
check(ordersRows[0]!.attempts === 3, `first orders delivery: expected 3 attempts, got ${ordersRows[0]!.attempts}`);
check(seenIds.get(`orders shop:${ordersRows[0]!.event.id}`) === 3, "retries should reuse the same ringd-id");
console.log(`orders retries ${ordersRows.map((d) => d.attempts).join(", ")} attempts (same ringd-id)`);

// The dead webhook gave up after maxAttempts; retryFailed requeues them.
const dead = store.listDeliveries({ webhook: "dead" });
check(dead.length === 2 && dead.every((d) => d.status === "failed" && d.attempts === 3), "dead deliveries should fail");
check(store.retryFailed("dead") === 2 && store.listDeliveries({ webhook: "dead", status: "pending" }).length === 2, "retryFailed");
console.log(`dead webhook   ${dead.length} failed after ${delivery.maxAttempts} attempts, requeued by retryFailed`);

store.close();
server.close();
console.log("ok: ringd events, signed webhooks with retry, idempotent ids, failure + requeue, auto-merge without the spending key");
