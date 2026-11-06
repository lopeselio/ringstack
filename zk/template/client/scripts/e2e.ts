/**
 * The template vault on devnet, end to end:
 *   deposit twice → lock part of it until ~40 s from now → a release before
 *   then is refused by the program (NotYetUnlocked) → wait → release → the
 *   balance is whole again and no vault is open.
 *
 * Needs the program deployed at TEMPLATE_PROGRAM_ID (default: its declare_id),
 * the wasm module built (see src/wasm.ts), and the usual devnet env:
 *   ZOLANA_NETWORK=devnet API_KEY=... ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json
 *   pnpm --filter @ringstack/zk-template-client e2e
 */
import { ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { DepositAsset, depositInstruction } from "@heliuslabs/zolana/interface";
import { ShieldedPda, randomBlinding, solanaOwnerIdentity } from "@heliuslabs/zolana/keypair";
import { AssetRegistry, ProgramOwner, bindProgramTransaction, type ProgramWalletUtxo } from "@heliuslabs/zolana/transaction";
import { clientConfigFromEnv, fund } from "@ringstack/core";
import { address, getAddressEncoder } from "@solana/kit";

import {
  NOT_YET_UNLOCKED,
  TEMPLATE_PROGRAM_ID,
  VAULT_OUTPUT_SLOT,
  creatorTransactions,
  lockInstruction,
  openVaults,
  prove,
  releaseInstruction,
  sendAndConfirmFactory,
  spendableSol,
  vaultAuthority,
} from "../src/vault.ts";
import { loadWasm } from "../src/wasm.ts";

const DEPOSITS = [5_000_000n, 5_000_000n] as const;
const LOCK_AMOUNT = 7_000_000n;
const LOCK_SECONDS = 40n;

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const total = (utxos: readonly ProgramWalletUtxo[]) => utxos.reduce((sum, u) => sum + u.utxo.amount, 0n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `{ Custom: n }` code inside a failed transaction's error, wherever the RPC nests it. */
function customError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (error === null || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  const custom = (error as Record<string, unknown>)["Custom"];
  if (typeof custom === "number" || typeof custom === "bigint") return Number(custom);
  for (const value of [...Object.values(error), (error as { cause?: unknown }).cause, (error as { context?: unknown }).context]) {
    const found = customError(value, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

await initializePoseidon();
const client = await createZolanaClient(clientConfigFromEnv());
const programId = process.env["TEMPLATE_PROGRAM_ID"] ? address(process.env["TEMPLATE_PROGRAM_ID"]) : TEMPLATE_PROGRAM_ID;
const program = await client.solanaRpc.getAccountInfo(programId, { encoding: "base64" }).send();
check(program.value?.executable === true, `no program deployed at ${programId} on this network`);
const wasm = await loadWasm();

const chainTime = async () => {
  const slot = await client.solanaRpc.getSlot({ commitment: "confirmed" }).send();
  return BigInt((await client.solanaRpc.getBlockTime(slot).send()) ?? 0n);
};

const creator = ShieldedKeypair.generate();
const signer = creator.toSolanaSigner();
const viewingKey = creator.viewingKey();
try {
  await fund(client, signer.address, 30_000_000n);
  const send = sendAndConfirmFactory(client, signer);
  const assets = new AssetRegistry();
  const buildLock = bindProgramTransaction(wasm.lockTransaction, { assets });
  const buildRelease = bindProgramTransaction(wasm.releaseTransaction, { assets });
  const shieldedAddress = creator.shieldedAddress();
  const sender = shieldedAddress.toBytes();
  const authority = await vaultAuthority(signer.address, programId);
  const creatorIdentity = solanaOwnerIdentity(Uint8Array.from(getAddressEncoder().encode(signer.address)));
  const txContext = () => ({ blindingSeed: randomBlinding(), outputTreeId: client.treeId });
  const shielded = DEPOSITS.reduce((s, a) => s + a, 0n);
  console.log(`program ${programId}\ncreator ${signer.address}`);

  const depositSlot = await send([
    await depositInstruction({
      tree: client.tree,
      depositor: signer,
      deposits: DEPOSITS.map((amount) => ({
        asset: DepositAsset.sol(),
        viewTag: shieldedAddress.confidentialViewTag(),
        recipientOwnerHash: shieldedAddress.ownerHash(),
        amount,
      })),
    }),
  ]);
  const deposited = await spendableSol(client, creator, await creatorTransactions(client, creator, authority, depositSlot), assets);
  check(total(deposited) === shielded && deposited.length === 2, `deposited ${total(deposited)} in ${deposited.length}`);
  console.log(`deposited ${shielded} lamports in 2 UTXOs`);

  // Lock.
  const unlock = (await chainTime()) + LOCK_SECONDS;
  const lockTx = await buildLock(
    {
      private: { txContext: txContext(), tokenUtxosAssetA: [...deposited], unlock, amount: LOCK_AMOUNT },
      public: { vaultOwner: authority.address(shieldedAddress.viewingPublicKey).toBytes(), creatorIdentity },
    },
    sender,
    signer.address,
  );
  const lockProof = prove(wasm, "lock", lockTx.proofInputs);
  check(Buffer.from(lockProof.publicInputs[0] ?? []).equals(Buffer.from(lockTx.publicHash)), "lock public hash");
  const lockTransact = await client.proveTransact(lockTx.transaction.encryptWithKeys(creator), [creator]);
  const lockSlot = await send([
    await lockInstruction({
      programId,
      client,
      creator: signer,
      authority,
      proof: lockProof.compressedProof,
      viewingPublicKey: shieldedAddress.viewingPublicKey,
      transact: lockTransact,
    }),
  ]);
  const afterLock = await creatorTransactions(client, creator, authority, lockSlot);
  const vaults = openVaults(wasm, viewingKey, afterLock, authority, assets, client.treeId);
  const [vault] = vaults;
  check(vaults.length === 1 && vault !== undefined, `expected one open vault, found ${vaults.length}`);
  check(vault.data.unlock === unlock, "the vault commits the unlock time");
  check(
    Buffer.from(vault.utxo.utxoHash).equals(Buffer.from(lockTx.transaction.outputHashes[VAULT_OUTPUT_SLOT] ?? [])),
    "the vault is the lock's vault output",
  );
  const left = total(await spendableSol(client, creator, afterLock, assets));
  check(left === shielded - LOCK_AMOUNT, `spendable after lock ${left}`);
  console.log(`locked ${LOCK_AMOUNT} until ${unlock}; ${left} still spendable`);

  // Release, built and proved once per attempt.
  const release = async () => {
    const tx = await buildRelease(
      {
        private: { txContext: txContext(), vault: vault.utxo, terms: vault.data },
        public: { unlock: vault.data.unlock, creatorIdentity },
      },
      sender,
      signer.address,
    );
    const proof = prove(wasm, "release", tx.proofInputs);
    const pda = ShieldedPda.withViewingKey(authority.pda, ProgramOwner.nullifierKey(), creator.viewingKey());
    const transact = await client.proveTransact(tx.transaction.encryptWithKeys(creator), [pda]).finally(() => pda.destroy());
    return send([
      await releaseInstruction({ programId, client, creator: signer, authority, proof: proof.compressedProof, unlock: vault.data.unlock, transact }),
    ]);
  };

  // Too early: the program checks the clock before anything else.
  const early = await release().then(
    () => undefined,
    (error: unknown) => error,
  );
  check(early !== undefined, "a release before the unlock time was accepted");
  check(customError(early) === NOT_YET_UNLOCKED, `early release failed for another reason: ${String(early)}`);
  console.log("early release → refused onchain (NotYetUnlocked)");

  while ((await chainTime()) <= unlock) await sleep(3_000);
  const releaseSlot = await release();
  const afterRelease = await creatorTransactions(client, creator, authority, releaseSlot);
  const balance = total(await spendableSol(client, creator, afterRelease, assets));
  const open = openVaults(wasm, viewingKey, afterRelease, authority, assets, client.treeId);
  check(balance === shielded && open.length === 0, `after release: balance ${balance}, ${open.length} vaults open`);
  console.log(`released after unlock → balance ${balance}, no vault open`);
  console.log("ok: deposit, lock with a program proof, onchain timelock refusal, release");
} finally {
  viewingKey.destroy();
  creator.destroy();
}
