/**
 * Localnet memo round trip (src/memo.ts):
 *   confidential transfer with an encrypted order-id memo on the recipient's
 *   output → the recipient reads it from their balance → a receipt shows it.
 * Also checks that the sender's change carries no memo (so SDK wallets can
 * still spend it) and that commitments still verify.
 *
 *   pnpm --filter @ringstack/core memo:e2e
 */
import { SOL_MINT } from "@heliuslabs/zolana";
import { atSlot } from "@heliuslabs/zolana/client";
import { decryptToBalances } from "@heliuslabs/zolana/transaction";

import { decodeMemo, encodeMemo } from "../src/memo.ts";
import { networkFromEnv } from "../src/config.ts";
import { decodeReceipt, encodeReceipt } from "../src/receipt.ts";
import { fetchShieldedTransaction, issueReceipt, openReceipt } from "../src/receipt-open.ts";
import { TRANSFER, depositAndTransfer } from "./flow.ts";

const ORDER = "order:7f3a-2026-11-01";

const { client, sender, recipient, assets, transferTx } = await depositAndTransfer({ memo: encodeMemo(ORDER) });
const tx = await fetchShieldedTransaction(client, transferTx.signature);

// Recipient side: the memo rides in their UTXO.
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
const recipientMemo = decodeMemo(received.data.memo());
console.log(`recipient memo  ${JSON.stringify(recipientMemo)}`);
if (recipientMemo !== ORDER) throw new Error("recipient did not read the memo");

// Verifier side: the receipt shows the memo next to the verified amount.
const receipt = decodeReceipt(encodeReceipt(issueReceipt(sender, tx, networkFromEnv())));
const opened = openReceipt(receipt, tx, { knownAddresses: [recipient.shieldedAddress(), sender.shieldedAddress()] });
for (const o of opened.outputs) {
  console.log(`  slot ${o.slot}: ${o.amount}, memo ${JSON.stringify(decodeMemo(o.memo) ?? null)}, commitment ${o.commitment}`);
}
const recipientKey = recipient.viewingPublicKey().toBytes();
const paid = opened.outputs.find((o) => o.recipientViewingKey.toBytes().every((v, i) => v === recipientKey[i]));
if (paid?.commitment !== "verified" || decodeMemo(paid.memo) !== ORDER) throw new Error("receipt memo not verified");
const change = opened.outputs.find((o) => o !== paid);
if (change?.commitment !== "verified" || change.memo !== undefined) throw new Error("change should carry no memo");

// Known leak: the memo slot is longer than the change slot.
const lengths = tx.outputSlots.map((s) => s.payload.length);
console.log(`slot payload lengths  ${lengths.join(", ")} (memo slot ${paid.slot})`);

console.log(`ok: memo ${JSON.stringify(ORDER)} delivered to recipient and shown on receipt`);
