/**
 * The milestone escrow on devnet, end to end:
 *   an escrow that is already expired is refused → the funder escrows 9M
 *   lamports for a payee, 3M per milestone, 2 of 3 approvers to release,
 *   refundable after ~3 minutes, under an escrow viewing key shared with the
 *   payee → release 1 (A and C), built by the funder → a proof made for A and
 *   B but signed by A alone is refused (the program computes who signed) →
 *   an early refund is refused → release 2 (B and C), built and paid for by
 *   the payee → after the deadline a release is refused and the refund
 *   returns the last tranche to the funder.
 *
 * Needs the program deployed at ESCROW_PROGRAM_ID (default: its declare_id),
 * the wasm module built (see src/wasm.ts), and the usual devnet env:
 *   ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json
 *   pnpm --filter @ringstack/milestone-escrow-client e2e
 */
import { ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import { CompressedShieldedAddress, ViewingKey, randomBlinding } from "@heliuslabs/spr/keypair";
import { ProgramOwner, ShieldedPda, bindProgramTransaction } from "@heliuslabs/spr/program";
import { AssetRegistry } from "@heliuslabs/spr/transaction";
import { clientConfigFromEnv, fund } from "@ringstack/core";
import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  address,
  generateKeyPairSigner,
  isSolanaError,
  type TransactionSigner,
} from "@solana/kit";

import {
  CREATE_ESCROW_SLOT,
  ESCROW_PROGRAM_ID,
  EXPIRED,
  NOT_EXPIRED,
  PROOF_VERIFICATION_FAILED,
  approverSlots,
  createInstruction,
  escrowAuthority,
  identityOf,
  openEscrows,
  prove,
  refundInstruction,
  releaseInstruction,
  sendAndConfirmFactory,
  spendableSol,
  taggedTransactions,
  total,
} from "../src/escrow.ts";
import { loadWasm } from "../src/wasm.ts";

const DEPOSITS = [6_000_000n, 6_000_000n] as const;
const AMOUNT = 9_000_000n;
const TRANCHE = 3_000_000n;
const THRESHOLD = 2;
const DEADLINE_SECONDS = 180n;

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: Uint8Array | number[], b: Uint8Array | number[]) => Buffer.from(a).equals(Buffer.from(b));

function customError(error: unknown): number | undefined {
  for (let e: unknown = error; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(e.context.code);
  }
  return undefined;
}

function logsOf(error: unknown): string {
  const context = (error as { context?: { logs?: unknown } } | undefined)?.context;
  return Array.isArray(context?.logs) ? `\n  ${context.logs.join("\n  ")}` : "";
}

/** `attempt` must fail onchain with `code`. */
async function refused(label: string, code: number, attempt: () => Promise<unknown>): Promise<void> {
  const error = await attempt().then(
    () => undefined,
    (e: unknown) => e,
  );
  check(error !== undefined, `${label} was accepted`);
  check(customError(error) === code, `${label} failed for another reason: ${String(error)}${logsOf(error)}`);
  console.log(`${label} → refused onchain (${code})`);
}

await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());
const programId = process.env["ESCROW_PROGRAM_ID"] ? address(process.env["ESCROW_PROGRAM_ID"]) : ESCROW_PROGRAM_ID;
const program = await client.solanaRpc.getAccountInfo(programId, { encoding: "base64" }).send();
check(program.value?.executable === true, `no program deployed at ${programId} on this network`);
const wasm = await loadWasm();

const chainTime = async () => {
  const slot = await client.solanaRpc.getSlot({ commitment: "confirmed" }).send();
  return BigInt((await client.solanaRpc.getBlockTime(slot).send()) ?? 0n);
};

const funder = ShieldedKeypair.generate();
const payee = ShieldedKeypair.generate();
const funderSigner = funder.toSolanaSigner();
const payeeSigner = payee.toSolanaSigner();
// The escrow's own viewing key. The funder shares it with the payee (any
// channel), so either can see the escrow and build a release.
const escrowKey = ViewingKey.generate();
const payeeEscrowKey = ViewingKey.fromBytes(escrowKey.secretBytes());
const [a, b, c] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
try {
  await fund(client, funderSigner.address, 40_000_000n);
  await fund(client, payeeSigner.address, 10_000_000n); // fees for the release the payee sends
  const send = sendAndConfirmFactory(client, funderSigner);
  const assets = new AssetRegistry();
  const buildCreate = bindProgramTransaction(wasm.createTransaction, { assets });
  const buildRelease = bindProgramTransaction(wasm.releaseTransaction, { assets });
  const buildRefund = bindProgramTransaction(wasm.refundTransaction, { assets });
  const funderAddress = funder.shieldedAddress();
  const payeeAddress = payee.shieldedAddress();
  const sender = funderAddress.toBytes();
  const authority = await escrowAuthority(funderSigner.address, programId);
  const escrowOwner = authority.address(escrowKey.publicKey()).toBytes();
  const funderIdentity = identityOf(funderSigner.address);
  const payeeHash = CompressedShieldedAddress.fromAddress(payeeAddress).hash();
  const funderTags = [funderAddress.confidentialViewTag(), authority.ownerTag()];
  const txContext = () => ({ blindingSeed: randomBlinding(), outputTreeId: client.treeId });
  const pdaSigner = (key: ViewingKey) =>
    ShieldedPda.withViewingKey(authority.pda, ProgramOwner.nullifierKey(), ViewingKey.fromBytes(key.secretBytes()));
  console.log(`program ${programId}\nfunder  ${funderSigner.address}\napprovers ${a.address} ${b.address} ${c.address}`);

  // Deposit and create.
  const depositSlot = await send([
    await depositInstruction({
      tree: client.tree,
      depositor: funderSigner,
      deposits: DEPOSITS.map((amount) => ({
        asset: DepositAsset.sol(),
        viewTag: funderAddress.confidentialViewTag(),
        recipientOwnerHash: funderAddress.ownerHash(),
        amount,
      })),
    }),
  ]);
  const deposited = await spendableSol(client, funder, await taggedTransactions(client, funderTags, depositSlot), assets);
  check(total(deposited) === 12_000_000n, `deposited ${total(deposited)}`);

  const create = async (deadline: bigint) => {
    const tx = await buildCreate(
      {
        private: {
          txContext: txContext(),
          tokenUtxosAssetA: [...deposited],
          amount: AMOUNT,
          payee: payeeHash,
          approvers: approverSlots([a.address, b.address, c.address]),
          threshold: THRESHOLD,
          tranche: TRANCHE,
        },
        public: { escrowOwner, funderIdentity, deadline },
      },
      sender,
      funderSigner.address,
    );
    const proof = prove(wasm, "create", tx.proofInputs);
    const transact = await client.proveTransact(tx.transaction.encryptWithKeys(funder), [funder]);
    const slot = await send([
      await createInstruction({
        programId,
        client,
        payer: funderSigner,
        funder: funderSigner,
        authority,
        proof: proof.compressedProof,
        viewingPublicKey: escrowKey.publicKey(),
        deadline,
        transact,
      }),
    ]);
    return { tx, slot };
  };

  await refused("an escrow that is already expired", EXPIRED, async () => create((await chainTime()) - 10n));

  const deadline = (await chainTime()) + DEADLINE_SECONDS;
  const { tx: createTx, slot: createSlot } = await create(deadline);

  const escrowNow = async (slot: bigint) => {
    const open = openEscrows(wasm, escrowKey, await taggedTransactions(client, funderTags, slot), authority, assets, client.treeId);
    check(open.length <= 1, `expected at most one open escrow, found ${open.length}`);
    return open[0];
  };
  const payeeBalance = async (slot: bigint) =>
    total(await spendableSol(client, payee, await taggedTransactions(client, [payeeAddress.confidentialViewTag()], slot), assets));

  let escrow = await escrowNow(createSlot);
  check(escrow !== undefined, "no escrow after create");
  check(escrow.utxo.utxo.amount === AMOUNT, `escrow holds ${escrow.utxo.utxo.amount}`);
  check(same(escrow.utxo.utxoHash, createTx.transaction.outputHashes[CREATE_ESCROW_SLOT] ?? []), "the escrow is create's output");
  check(same(escrow.data.payee, payeeHash) && escrow.data.tranche === TRANCHE && escrow.data.threshold === THRESHOLD, "committed terms");
  console.log(`created: ${AMOUNT} escrowed, ${TRANCHE} per milestone, ${THRESHOLD} of 3 approvers, refundable after ${deadline}`);

  /** Who builds and pays for a release: anyone holding the escrow's viewing key. */
  const funderBuilds = { keypair: funder, signer: funderSigner, key: escrowKey, send };
  const payeeBuilds = { keypair: payee, signer: payeeSigner, key: payeeEscrowKey, send: sendAndConfirmFactory(client, payeeSigner) };

  /** Builds, proves and sends a release; `provedFor` lets a test lie about who signs. */
  const release = async (
    signers: readonly TransactionSigner[],
    provedFor: readonly TransactionSigner[] = signers,
    builder = funderBuilds,
  ) => {
    check(escrow !== undefined, "no open escrow");
    const tx = await buildRelease(
      {
        private: { txContext: txContext(), escrow: escrow.utxo, terms: escrow.data, payee: payeeAddress.toBytes(), escrowOwner },
        public: { deadline, funderIdentity, signers: approverSlots(provedFor.map((s) => s.address)) },
      },
      builder.keypair.shieldedAddress().toBytes(),
      builder.signer.address,
    );
    const proof = prove(wasm, "release", tx.proofInputs);
    const pda = pdaSigner(builder.key);
    const transact = await client
      .proveTransact(tx.transaction.encryptWithKeys(builder.keypair), [pda])
      .finally(() => pda.destroy());
    return builder.send([
      await releaseInstruction({
        programId,
        client,
        payer: builder.signer,
        funder: funderSigner.address,
        approvers: signers,
        authority,
        proof: proof.compressedProof,
        deadline,
        transact,
      }),
    ]);
  };

  const refund = async () => {
    check(escrow !== undefined, "no open escrow");
    const tx = await buildRefund(
      { private: { txContext: txContext(), escrow: escrow.utxo, terms: escrow.data }, public: { deadline, funderIdentity } },
      sender,
      funderSigner.address,
    );
    const proof = prove(wasm, "refund", tx.proofInputs);
    const pda = pdaSigner(escrowKey);
    const transact = await client.proveTransact(tx.transaction.encryptWithKeys(funder), [pda]).finally(() => pda.destroy());
    return send([
      await refundInstruction({ programId, client, payer: funderSigner, funder: funderSigner, authority, proof: proof.compressedProof, deadline, transact }),
    ]);
  };

  // Release 1: A and C, built by the funder.
  let slot = await release([a, c]);
  escrow = await escrowNow(slot);
  check(escrow?.utxo.utxo.amount === AMOUNT - TRANCHE, `escrow after release 1: ${escrow?.utxo.utxo.amount}`);
  check((await payeeBalance(slot)) === TRANCHE, "the payee received one tranche");
  console.log(`release 1 (A, C) → payee has ${TRANCHE}, ${AMOUNT - TRANCHE} still escrowed`);

  await refused("a proof for A and B signed by A alone", PROOF_VERIFICATION_FAILED, () => release([a], [a, b]));
  await refused("a refund before the deadline", NOT_EXPIRED, refund);

  // Release 2: B and C, built and paid for by the payee, who needs nothing
  // from the funder but the escrow's viewing key.
  slot = await release([b, c], [b, c], payeeBuilds);
  escrow = await escrowNow(slot);
  check(escrow?.utxo.utxo.amount === AMOUNT - 2n * TRANCHE, `escrow after release 2: ${escrow?.utxo.utxo.amount}`);
  check((await payeeBalance(slot)) === 2n * TRANCHE, "the payee received two tranches");
  console.log(`release 2 (B, C), sent by the payee → payee has ${2n * TRANCHE}, ${AMOUNT - 2n * TRANCHE} still escrowed`);

  while ((await chainTime()) <= deadline) await sleep(3_000);
  await refused("a release after the deadline", EXPIRED, () => release([a, b]));

  slot = await refund();
  check((await escrowNow(slot)) === undefined, "no escrow open after the refund");
  const funderBalance = total(await spendableSol(client, funder, await taggedTransactions(client, funderTags, slot), assets));
  // 12M deposited - 9M escrowed + 3M refunded.
  check(funderBalance === 6_000_000n, `funder balance after refund ${funderBalance}`);
  console.log(`refund → funder has ${funderBalance} back in the pool; no escrow open`);
  console.log("ok: create, two 2-of-3 releases (one built by the payee), signer binding, three deadline checks, refund");
} finally {
  escrowKey.destroy();
  payeeEscrowKey.destroy();
  funder.destroy();
  payee.destroy();
}
