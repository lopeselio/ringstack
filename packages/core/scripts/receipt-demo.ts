/**
 * Make a demo receipt on localnet: a registered customer pays a registered
 * merchant 0.0125 SOL with an order-id memo, then issues the receipt.
 * Prints the receipt link and a verifier URL.
 *
 *   pnpm --filter @ringstack/core receipt:demo [verifier-base-url]
 */
import { ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";

import { clientConfigFromEnv, networkFromEnv } from "../src/config.ts";
import { fund } from "../src/fund.ts";
import { encodeMemo } from "../src/memo.ts";
import { encodeReceipt } from "../src/receipt.ts";
import { fetchShieldedTransaction, issueReceipt } from "../src/receipt-open.ts";
import { RingSession } from "../src/session.ts";

const verifierBase = process.argv[2] ?? "http://localhost:5173/";

await initializePoseidon();
const client = await createZolanaClient(clientConfigFromEnv());

const customer = await RingSession.open(client, ShieldedKeypair.generate());
const merchant = await RingSession.open(client, ShieldedKeypair.generate());
for (const s of [customer, merchant]) {
  await fund(client, s.owner, s === customer ? 80_000_000n : 20_000_000n);
  await s.register();
}
await customer.deposit(50_000_000n);
const paid = await customer.transfer(merchant.owner, 12_500_000n, { memo: encodeMemo("order:1042") });

const tx = await fetchShieldedTransaction(client, paid.signature);
const link = encodeReceipt(issueReceipt(customer.keypair, tx, networkFromEnv()));

console.log(`customer ${customer.owner}`);
console.log(`merchant ${merchant.owner}`);
console.log(`receipt  ${link}`);
console.log(`verify   ${verifierBase}#${link}`);
