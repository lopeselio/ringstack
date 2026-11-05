/**
 * Localnet run of every RingSession helper (src/session.ts):
 *   register both → alice deposits twice → enables merge → merges →
 *   transfers to bob by Solana address (plain, then with a memo) →
 *   bob withdraws to a fresh public address.
 *
 *   pnpm --filter @ringstack/core session:e2e
 */
import { SOL_MINT, ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { generateKeyPairSigner } from "@solana/kit";

import { clientConfigFromEnv } from "../src/config.ts";
import { fund } from "../src/fund.ts";
import { decodeMemo, encodeMemo } from "../src/memo.ts";
import { RingSession } from "../src/session.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await initializePoseidon();
const client = await createZolanaClient(clientConfigFromEnv());

const alice = await RingSession.open(client, ShieldedKeypair.generate());
const bob = await RingSession.open(client, ShieldedKeypair.generate());
await fund(client, alice.owner, 80_000_000n); // deposits 50M + rent and fees
await fund(client, bob.owner, 20_000_000n);
console.log(`alice ${alice.owner}\nbob   ${bob.owner}`);

// Registration (idempotent).
check((await alice.register()) !== undefined, "alice register");
check((await bob.register()) !== undefined, "bob register");
check((await alice.register()) === undefined, "second register should be a no-op");
console.log("registered both");

// Two deposits → two UTXOs.
await alice.deposit(20_000_000n);
await alice.deposit(30_000_000n);
check(alice.balance() === 50_000_000n, `alice balance ${alice.balance()}`);
check(alice.wallet.balance(SOL_MINT).utxos.length === 2, "expected 2 utxos before merge");
console.log("deposited 20M + 30M");

// Merge opt-in, then merge.
check((await alice.mergeEnabled()) === false, "merge should start disabled");
await alice.setMerge(true);
check((await alice.mergeEnabled()) === true, "merge not enabled");
await alice.merge();
const afterMerge = alice.wallet.balance(SOL_MINT);
console.log(`merged: ${afterMerge.utxos.length} utxo(s), ${afterMerge.amount}`);
check(afterMerge.amount === 50_000_000n && afterMerge.utxos.length === 1, "merge result");

// Transfers to bob by Solana address.
await alice.transfer(bob.owner, 10_000_000n);
const ORDER = "order:session-e2e";
await alice.transfer(bob.owner, 5_000_000n, { memo: encodeMemo(ORDER) });
await bob.sync();
check(bob.balance() === 15_000_000n, `bob balance ${bob.balance()}`);
check(alice.balance() === 35_000_000n, `alice balance ${alice.balance()}`);
const memos = bob.wallet.balance(SOL_MINT).utxos.map((u) => decodeMemo(u.data.memo()));
check(memos.includes(ORDER), `bob memos ${JSON.stringify(memos)}`);
console.log(`transferred 10M + 5M (memo ${JSON.stringify(ORDER)})`);

// Withdraw to a fresh public address.
const cashOut = (await generateKeyPairSigner()).address;
await bob.withdraw(cashOut, 4_000_000n);
const { value: publicLamports } = await client.solanaRpc.getBalance(cashOut).send();
check(publicLamports === 4_000_000n, `public balance ${publicLamports}`);
check(bob.balance() === 11_000_000n, `bob balance after withdraw ${bob.balance()}`);
console.log(`withdrew 4M to ${cashOut}`);

// Bob's remaining 11M is 6M plain + 5M carrying a memo, which the SDK's default
// selection skips; RingSession falls back to the lower-level builder.
await bob.transfer(alice.owner, 11_000_000n);
await alice.sync();
check(bob.balance() === 0n, `bob balance after spending memo funds ${bob.balance()}`);
check(alice.balance() === 46_000_000n, `alice balance ${alice.balance()}`);
console.log("bob spent funds including a memo payment");

// Memo funds through merge and withdrawal (both skip memo UTXOs in the SDK).
await alice.transfer(bob.owner, 3_000_000n, { memo: encodeMemo("order:a") });
await alice.transfer(bob.owner, 4_000_000n, { memo: encodeMemo("order:b") });
await bob.sync();
check(bob.wallet.balance(SOL_MINT).utxos.length === 2, "bob should hold 2 memo utxos");
await bob.setMerge(true);
await bob.merge();
const merged = bob.wallet.balance(SOL_MINT);
check(merged.amount === 7_000_000n && merged.utxos.length === 1, `merge of memo utxos: ${merged.utxos.length} / ${merged.amount}`);
check(merged.utxos[0]!.data.isEmpty(), "merged output should be plain");
console.log("merged 2 memo payments into 1 plain utxo");

await alice.transfer(bob.owner, 2_000_000n, { memo: encodeMemo("order:c") });
await bob.sync();
const cashOut2 = (await generateKeyPairSigner()).address;
await bob.withdraw(cashOut2, 5_000_000n);
const { value: public2 } = await client.solanaRpc.getBalance(cashOut2).send();
check(public2 === 5_000_000n, `public balance after memo withdrawal ${public2}`);
check(bob.balance() === 4_000_000n, `bob balance after memo withdrawal ${bob.balance()}`);
console.log(`withdrew 5M (incl. a memo payment) to ${cashOut2}`);

console.log("ok: register, setMerge, deposit, merge, transfer (+memo), withdraw, spend/merge/withdraw memo funds");
