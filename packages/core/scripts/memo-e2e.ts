/**
 * Localnet memo round trip (src/memo.ts):
 *   confidential transfer with an encrypted order-id memo on the recipient's
 *   output → the recipient reads it from their balance → a receipt shows it.
 * A second recipient with its own memo makes the transfer padded (2 payments
 * and change are 3 real outputs, which publish 4 slots), so the memos only
 * read back if their ordinals count the padded slot. Also checks that the
 * sender's change carries no memo (so SDK wallets can still spend it) and that
 * commitments still verify.
 *
 *   pnpm --filter @ringstack/core memo:e2e
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { atSlot } from "@heliuslabs/spr/client";
import { decryptToBalances } from "@heliuslabs/spr/transaction";

import { decodeMemo, encodeMemo, receivedMemos } from "../src/memo.ts";
import { networkFromEnv } from "../src/config.ts";
import { decodeReceipt, encodeReceipt } from "../src/receipt.ts";
import { fetchShieldedTransaction, issueReceipt, openReceipt } from "../src/receipt-open.ts";
import { TRANSFER, depositAndTransfer } from "./flow.ts";

const ORDER = "order:7f3a-2026-11-01";
const SECOND = "order:7f3b-2026-11-01";

const { client, sender, recipient, second, assets, transferTx } = await depositAndTransfer({
  memo: encodeMemo(ORDER),
  secondMemo: encodeMemo(SECOND),
});
if (second === undefined) throw new Error("expected a second recipient");
const tx = await fetchShieldedTransaction(client, transferTx.signature);

// Recipient side: the memo rides in a message addressed to their output, which stays plain.
const resp = await client.getShieldedTransactionsBySignature(transferTx.signature, atSlot(transferTx.slot));
const balance = (
  await decryptToBalances({
    keypair: recipient,
    registry: assets,
    transactions: resp.transactions.map(({ transaction }) => transaction),
  })
).balance(SOL_MINT);
const received = balance.utxos[0];
if (received?.amount !== TRANSFER) throw new Error(`recipient: expected ${TRANSFER}, got ${received?.amount}`);
if (!received.data.isEmpty()) throw new Error("recipient output should be plain (memo travels as a message)");
const recipientMemo = [...receivedMemos(tx, recipient.shieldedAddress(), recipient.viewingKey()).values()][0];
console.log(`recipient memo  ${JSON.stringify(recipientMemo)}`);
if (recipientMemo !== ORDER) throw new Error("recipient did not read the memo");
const secondMemo = [...receivedMemos(tx, second.shieldedAddress(), second.viewingKey()).values()][0];
console.log(`second memo     ${JSON.stringify(secondMemo)}`);
if (secondMemo !== SECOND) throw new Error("second recipient did not read the memo");

// Verifier side: the receipt shows the memo next to the verified amount.
const receipt = decodeReceipt(encodeReceipt(issueReceipt(sender, tx, networkFromEnv())));
const opened = openReceipt(receipt, tx, {
  knownAddresses: [recipient.shieldedAddress(), second.shieldedAddress(), sender.shieldedAddress()],
});
for (const o of opened.outputs) {
  console.log(`  slot ${o.slot}: ${o.amount}, memo ${JSON.stringify(decodeMemo(o.memo) ?? null)}, commitment ${o.commitment}`);
}
const outputTo = (key: Uint8Array) =>
  opened.outputs.find((o) => o.recipientViewingKey.toBytes().every((v, i) => v === key[i]));
const paid = outputTo(recipient.viewingPublicKey().toBytes());
if (paid?.commitment !== "verified" || decodeMemo(paid.memo) !== ORDER) throw new Error("receipt memo not verified");
const paidSecond = outputTo(second.viewingPublicKey().toBytes());
if (paidSecond?.commitment !== "verified" || decodeMemo(paidSecond.memo) !== SECOND) {
  throw new Error("receipt memo for the second recipient not verified");
}
const change = outputTo(sender.viewingPublicKey().toBytes());
if (change?.commitment !== "verified" || change.memo !== undefined) throw new Error("change should carry no memo");

// Four equal output slots (one of them padding); each memo is one fixed-width message.
const lengths = tx.outputSlots.map((s) => s.payload.length);
console.log(`slot payload lengths  ${lengths.join(", ")}; ${tx.messages.length} messages of ${tx.messages[0]?.data.length} bytes`);
if (lengths.length !== 4 || new Set(lengths).size !== 1 || tx.messages.length !== 2) {
  throw new Error("expected 4 equal slots and two memo messages");
}

console.log(`ok: memos ${JSON.stringify(ORDER)} and ${JSON.stringify(SECOND)} delivered in a padded transfer and shown on the receipt`);
