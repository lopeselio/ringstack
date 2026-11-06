/**
 * Localnet receipt round trip (spec/receipt.md):
 *   sender issues a receipt for a confidential transfer → encode → decode →
 *   a verifier opens it and recomputes the recipient's commitment.
 * Negative checks: a third party cannot issue one, a receipt cannot open a
 * different transaction, and a tampered key is rejected.
 *
 *   pnpm --filter @ringstack/core receipt:e2e
 */
import { ShieldedKeypair } from "@heliuslabs/spr";
import { SOL_MINT } from "@heliuslabs/spr/transaction";

import { networkFromEnv } from "../src/config.ts";
import { decodeReceipt, encodeReceipt } from "../src/receipt.ts";
import { ReceiptError, fetchShieldedTransaction, issueReceipt, openReceipt } from "../src/receipt-open.ts";
import { DEPOSIT, TRANSFER, depositAndTransfer } from "./flow.ts";

function expectReceiptError(code: ReceiptError["code"], fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReceiptError && e.code === code) return;
    throw new Error(`expected ReceiptError ${code}, got ${String(e)}`);
  }
  throw new Error(`expected ReceiptError ${code}, but call succeeded`);
}

const { client, sender, recipient, deposit, transferTx } = await depositAndTransfer();
const tx = await fetchShieldedTransaction(client, transferTx.signature);

// Sender issues and shares the receipt.
const link = encodeReceipt(issueReceipt(sender, tx, networkFromEnv()));
console.log(`receipt  ${link.slice(0, 48)}… (${link.length} chars)`);

// Verifier: decode, fetch, open. Knows the recipient (merchant) and sender addresses.
const receipt = decodeReceipt(link);
const opened = openReceipt(receipt, await fetchShieldedTransaction(client, receipt.signature), {
  knownAddresses: [recipient.shieldedAddress(), sender.shieldedAddress()],
});
const recipientKey = recipient.viewingPublicKey().toBytes();
const senderKey = sender.viewingPublicKey().toBytes();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
for (const o of opened.outputs) {
  const key = o.recipientViewingKey.toBytes();
  const who = eq(key, recipientKey) ? "recipient" : eq(key, senderKey) ? "sender (change)" : "unknown";
  console.log(`  slot ${o.slot}: ${o.amount} of ${o.mint ?? o.assetId} → ${who}, commitment ${o.commitment}`);
}
const paid = opened.outputs.find((o) => eq(o.recipientViewingKey.toBytes(), recipientKey));
const change = opened.outputs.find((o) => eq(o.recipientViewingKey.toBytes(), senderKey));
if (paid?.amount !== TRANSFER || paid.mint !== SOL_MINT || paid.commitment !== "verified") {
  throw new Error(`payment output not verified: ${JSON.stringify(paid, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
if (change?.amount !== DEPOSIT - TRANSFER || change.commitment !== "verified") {
  throw new Error("change output not verified");
}

// Without known addresses the amounts still decrypt, but nothing is commitment-checked.
const blind = openReceipt(receipt, tx);
if (!blind.outputs.every((o) => o.commitment === "unchecked")) throw new Error("expected unchecked outputs");

// Negative checks.
expectReceiptError("KEY_MISMATCH", () => issueReceipt(ShieldedKeypair.generate(), tx, networkFromEnv()));
// Byte 0's low 3 bits are cleared by X25519 clamping, so tamper a significant byte.
const tampered = { ...receipt, txViewingKey: receipt.txViewingKey.map((b, i) => (i === 10 ? b ^ 0xff : b)) };
expectReceiptError("KEY_MISMATCH", () => openReceipt(tampered, tx));
const depositTx = await fetchShieldedTransaction(client, deposit.signature);
expectReceiptError("SIGNATURE_MISMATCH", () => openReceipt(receipt, depositTx));

console.log(`ok: receipt verified payment ${paid.amount} + change ${change.amount}; negative checks passed`);
