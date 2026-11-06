/**
 * RingPay 402 paywall end to end (devnet or localnet):
 *   - unpaid call → 402 with a ringpay: request
 *   - agent pays privately with paidFetch → served, RingPay-Settled header
 *   - replaying the signature → refused (nonce already redeemed)
 *   - a payment for /v1/forecast cannot unlock /v1/alerts
 *   - per-call limit, host allow-list and daily budget refuse before paying
 *   - the vendor received exactly what the agent's ledger says
 *
 *   ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=… pnpm --filter @ringstack/paywall-demo e2e
 */
import type { AddressInfo } from "node:net";

import { SOL_MINT, ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";
import {
  RingSession,
  clientConfigFromEnv,
  exportKeyFile,
  fund,
  networkFromEnv,
  parseKeyFile,
  payRequest,
} from "@ringstack/core";
import { SpendLedger, SpendRefused, paidFetch, type SpendPolicy } from "@ringstack/paywall";

import { createDemoApp } from "../src/app.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const PRICE = "0.0005";
const PRICE_BASE = 500_000n;
const cluster = networkFromEnv();

await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());

// Vendor: registered; the API server gets only its read-only key file.
const vendor = await RingSession.open(client, ShieldedKeypair.generate());
await fund(client, vendor.owner, 20_000_000n);
await vendor.register();
const vendorKeys = parseKeyFile(exportKeyFile(vendor.keypair));

// Agent: a funded private balance.
const agent = await RingSession.open(client, ShieldedKeypair.generate());
await fund(client, agent.owner, 40_000_000n);
await agent.deposit(20_000_000n);
console.log(`vendor ${vendor.owner}\nagent  ${agent.owner} (0.02 SOL private)`);

const app = createDemoApp({
  paywall: {
    client,
    vendor: { address: vendorKeys.address, viewingSecret: vendorKeys.viewingSecret },
    recipient: vendor.owner,
    cluster,
    label: "Forecast API",
  },
  price: PRICE,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const host = new URL(base).host;

const ledger = new SpendLedger();
const policy: SpendPolicy = { maxPerCall: 1_000_000n, dailyBudget: 3n * PRICE_BASE, allowHosts: [host] };
const opts = { session: agent, cluster, policy, ledger };

// 1. Unpaid call.
const unpaid = await fetch(`${base}/v1/forecast?city=Lisbon`);
check(unpaid.status === 402 && unpaid.headers.get("ringpay-request")?.startsWith("ringpay:") === true, "expected a 402 challenge");
console.log("unpaid call   → 402 with a ringpay: request");

// 2. Paid call.
const paid = await paidFetch(`${base}/v1/forecast?city=Lisbon`, {}, opts);
check(paid.response.status === 200, `paid call: ${paid.response.status} ${await paid.response.clone().text()}`);
const body = (await paid.response.json()) as { city: string; days: unknown[] };
check(body.city === "Lisbon" && body.days.length === 3, "forecast body");
check(paid.response.headers.get("ringpay-settled") === paid.payment?.signature, "settled header");
console.log(`paid call     → 200 forecast for ${body.city}, paid ${paid.payment?.amount} in ${paid.payment?.signature.slice(0, 10)}…`);

// 3. Replay the same signature.
const replay = await fetch(`${base}/v1/forecast?city=Lisbon`, { headers: { "ringpay-payment": paid.payment!.signature } });
const replayBody = (await replay.json()) as { reason?: string };
check(replay.status === 402 && /already redeemed|unknown/.test(replayBody.reason ?? ""), `replay: ${replay.status} ${replayBody.reason}`);
console.log(`replay        → 402 (${replayBody.reason})`);

// 4. A forecast payment cannot unlock alerts.
const challenge = (await (await fetch(`${base}/v1/forecast?city=Porto`)).json()) as { ringpay: string };
const forecastPayment = await payRequest(agent, challenge.ringpay, { cluster });
const wrong = await fetch(`${base}/v1/alerts?city=Porto`, { headers: { "ringpay-payment": forecastPayment.payment.signature } });
const wrongBody = (await wrong.json()) as { reason?: string };
check(wrong.status === 402 && /different resource/.test(wrongBody.reason ?? ""), `cross-route: ${wrong.status} ${wrongBody.reason}`);
console.log(`cross-route   → 402 (${wrongBody.reason})`);
ledger.add({
  at: new Date().toISOString(),
  host,
  url: `${base}/v1/forecast`,
  recipient: vendor.owner,
  amount: forecastPayment.amount.toString(),
  signature: forecastPayment.payment.signature,
  order: "manual",
});

// 5. Policy refusals happen before any payment.
const before = agent.balance();
const refusal = async (p: SpendPolicy, url: string) => {
  try {
    await paidFetch(url, {}, { ...opts, policy: p });
  } catch (e) {
    if (e instanceof SpendRefused) return e.code;
    throw e;
  }
  return "paid";
};
check((await refusal({ ...policy, maxPerCall: 100_000n }, `${base}/v1/alerts`)) === "OVER_PER_CALL", "per-call limit");
check((await refusal({ ...policy, allowHosts: ["api.example.com"] }, `${base}/v1/alerts`)) === "HOST_NOT_ALLOWED", "host allow-list");
check((await refusal(policy, `${base}/v1/alerts`)) === "paid", "third call within budget");
check((await refusal(policy, `${base}/v1/alerts`)) === "OVER_DAILY_BUDGET", "daily budget");
await agent.sync();
check(before - agent.balance() === PRICE_BASE, `only the one allowed call should have moved funds (${before - agent.balance()})`);
console.log("policy        → per-call, host and daily-budget refusals moved no funds");

// 6. The vendor received exactly what the ledger records.
await vendor.sync();
const ledgerTotal = ledger.records.reduce((s, r) => s + BigInt(r.amount), 0n);
check(vendor.wallet.balance(SOL_MINT).amount === ledgerTotal, `vendor ${vendor.balance()} ≠ ledger ${ledgerTotal}`);
console.log(`vendor        → received ${ledgerTotal} lamports over ${ledger.records.length} payments, matching the ledger`);

await app.close();
console.log("ok: 402 challenge, private payment, served, replay and cross-route refused, spend policy enforced");
