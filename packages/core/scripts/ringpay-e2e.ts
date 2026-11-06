/**
 * Localnet RingPay flow (spec/ringpay-uri.md):
 *   merchant encodes a request → customer pays it with payRequest → the
 *   receipt verifies with the order memo → the merchant reads the order from
 *   the payment. Plus the wallet refusals.
 *
 *   pnpm --filter @ringstack/core ringpay:e2e
 */
import { SOL_MINT, ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";

import { clientConfigFromEnv, networkFromEnv } from "../src/config.ts";
import { fund } from "../src/fund.ts";
import { decodeReceipt } from "../src/receipt.ts";
import { fetchShieldedTransaction, openReceipt } from "../src/receipt-open.ts";
import { RingPayError, encodePaymentRequest, orderFromMemo } from "../src/ringpay.ts";
import { payRequest } from "../src/ringpay-pay.ts";
import { RingSession } from "../src/session.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectCode(code: RingPayError["code"], fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RingPayError && e.code === code) return;
    throw new Error(`expected ${code}, got ${String(e)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

const cluster = networkFromEnv();
const otherCluster = cluster === "localnet" ? "devnet" : "localnet";
await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());
const customer = await RingSession.open(client, ShieldedKeypair.generate());
const merchant = await RingSession.open(client, ShieldedKeypair.generate());
const stranger = ShieldedKeypair.generate().toSolanaSigner().address; // never registers
for (const s of [customer, merchant]) {
  await fund(client, s.owner, s === customer ? 80_000_000n : 20_000_000n);
}
await merchant.register();
await customer.deposit(50_000_000n);

// Merchant side: a request for order 1042.
const uri = encodePaymentRequest({
  recipient: merchant.owner,
  amount: "0.0125",
  order: "1042",
  label: "Corner Café",
  message: "Flat white",
  cluster,
});
console.log(`request  ${uri}`);

// Payer side.
const paid = await payRequest(customer, uri, { cluster });
console.log(`paid     ${paid.amount} lamports, tx ${paid.payment.signature.slice(0, 12)}…`);
console.log(`receipt  ${paid.receiptLink.slice(0, 40)}…`);
check(paid.amount === 12_500_000n, "amount");

// The receipt verifies against the merchant's address and shows the order.
const tx = await fetchShieldedTransaction(client, paid.payment.signature);
const opened = openReceipt(decodeReceipt(paid.receiptLink), tx, { knownAddresses: [merchant.address] });
const toMerchant = opened.outputs.find((o) => o.recipient !== undefined);
check(toMerchant?.commitment === "verified" && toMerchant.amount === 12_500_000n, "receipt payment not verified");
check(orderFromMemo(toMerchant.memo) === "1042", "receipt memo is not order 1042");
console.log(`receipt  verified ${toMerchant.amount}, order ${orderFromMemo(toMerchant.memo)}`);

// The merchant's wallet sees the payment with its order.
await merchant.sync();
const orders = [...(await merchant.receivedMemos(paid.payment.signature)).values()].map((m) => orderFromMemo(m));
check(orders.includes("1042"), `merchant orders ${JSON.stringify(orders)}`);
console.log(`merchant sees order 1042 (balance ${merchant.balance()})`);

// A request without amount: the payer chooses.
const tip = await payRequest(customer, encodePaymentRequest({ recipient: merchant.owner, label: "Tips", cluster }), {
  cluster,
  amount: 1_000_000n,
});
check(tip.amount === 1_000_000n, "tip amount");
console.log("paid a no-amount request with a chosen amount");

// Refusals: nothing is sent in any of these.
const before = customer.balance();
await expectCode("NOT_REGISTERED", () =>
  payRequest(customer, encodePaymentRequest({ recipient: stranger, amount: "0.001", cluster }), {
    cluster,
  }),
);
await expectCode("WRONG_CLUSTER", () => payRequest(customer, uri.replace(`cluster=${cluster}`, `cluster=${otherCluster}`), { cluster }));
await expectCode("AMOUNT_REQUIRED", () =>
  payRequest(customer, encodePaymentRequest({ recipient: merchant.owner, cluster }), { cluster }),
);
await expectCode("AMOUNT_MISMATCH", () => payRequest(customer, uri, { cluster, amount: 1n }));
check(customer.balance() === before, "a refused request moved funds");
console.log("refused: unregistered recipient, wrong cluster, missing amount, amount mismatch");

console.log("ok: ringpay request → private payment with order memo → verified receipt → merchant sees order");
