/**
 * Client for the milestone escrow program. Built from the template client
 * (zk/template/client): each instruction's program transaction comes from the
 * wasm circuits, is proved with the committed keys, gets the pool's proof
 * from the SDK's prover, and goes out as one verify-and-CPI instruction.
 */
import { readFileSync } from "node:fs";

import { SOL_MINT } from "@heliuslabs/spr";
import { atSlot, type PaginationToken, type SprClient } from "@heliuslabs/spr/client";
import { encodeTransactInstructionData, type TransactInstructionData } from "@heliuslabs/spr/interface";
import {
  bytes32,
  bytes64,
  solanaOwnerIdentity,
  type ShieldedKeypair,
  type ViewingKey,
  type ViewTag,
  type X25519PublicKey,
} from "@heliuslabs/spr/keypair";
import { ProgramOwner, toProgramWalletUtxo, transactCpiAccounts, type ProgramWalletUtxo } from "@heliuslabs/spr/program";
import {
  EncryptedScheme,
  LocalShieldedKeys,
  TransactionError,
  Wallet,
  decodeConfidential,
  decodeOutputData,
  decryptTransactions,
  type AssetRegistry,
  type IndexedShieldedTransaction,
} from "@heliuslabs/spr/transaction";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import type { CompressedGroth16Proof, DataUtxo, EscrowTerms, EscrowWasm, Proof } from "./wasm.ts";

/** `declare_id!` in zk/milestone-escrow/src/lib.rs. */
export const ESCROW_PROGRAM_ID = address("2XdkS7kQQcuCXQBhQv634B8PhDqFbpTPecHqMavwtMBR");
/** Approver slots in the terms (`APPROVERS`). */
export const APPROVERS = 3;
/** Output slots, from `instructions::{create,release}::slot`. */
export const CREATE_ESCROW_SLOT = 1;
export const RELEASE_ESCROW_SLOT = 0;
export const RELEASE_PAYOUT_SLOT = 1;
/** `EscrowError` codes. */
export const PROOF_VERIFICATION_FAILED = 9000;
export const NOT_EXPIRED = 9005;
export const EXPIRED = 9006;

const TAG = { create: 0, release: 1, refund: 2 } as const;
const AUTHORITY_SEED = "milestone_authority";
const TRANSACT_COMPUTE_UNIT_LIMIT = 1_400_000;
const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;
const KEYS = new URL("../../keys/", import.meta.url);
const NO_SIGNER = new Array<number>(32).fill(0);
const addressEncoder = getAddressEncoder();

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/** The identity the program computes for a signer: `solana_owner_identity`. */
export function identityOf(account: Address): Uint8Array {
  return solanaOwnerIdentity(Uint8Array.from(addressEncoder.encode(account)));
}

/**
 * The approver slots for a set of addresses, zero-padded: the committed
 * approver set at create, and at release the signers *in the same order as
 * their signer accounts*, since the program fills the public slots in
 * account order.
 */
export function approverSlots(approvers: readonly Address[]): number[][] {
  if (approvers.length > APPROVERS) throw new Error(`at most ${APPROVERS} approvers`);
  return Array.from({ length: APPROVERS }, (_, i) => {
    const approver = approvers[i];
    return approver === undefined ? [...NO_SIGNER] : Array.from(identityOf(approver));
  });
}

export function sendAndConfirmFactory(
  client: SprClient,
  feePayer: TransactionSigner,
): (instructions: readonly Instruction[]) => Promise<bigint> {
  const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  return async (instructions) => {
    const { value: lifetime } = await client.solanaRpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) =>
          setTransactionMessageConfig(
            { computeUnitLimit: TRANSACT_COMPUTE_UNIT_LIMIT, loadedAccountsDataSizeLimit: LOADED_ACCOUNTS_DATA_SIZE_LIMIT },
            m,
          ),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    await sendTransaction(signed, { commitment: "confirmed" });
    return client.confirmTransaction(getSignatureFromTransaction(signed));
  };
}

/** The PDA that owns a funder's escrows. */
export function escrowAuthority(funder: Address, programId: Address = ESCROW_PROGRAM_ID): Promise<ProgramOwner> {
  return ProgramOwner.find([AUTHORITY_SEED, addressEncoder.encode(funder)], programId);
}

/** Every transaction carrying one of `tags`, as of `slot`, across all pages. */
export async function taggedTransactions(
  client: SprClient,
  tags: readonly ViewTag[],
  slot: bigint,
): Promise<readonly IndexedShieldedTransaction[]> {
  const transactions: IndexedShieldedTransaction[] = [];
  let paginationToken: PaginationToken | null = null;
  do {
    const page = await client.getShieldedTransactionsByTags(
      { tags, limit: 100, ...(paginationToken === null ? {} : { paginationToken }) },
      atSlot(slot),
    );
    for (const tx of page.data) transactions.push(...tx.events);
    paginationToken = page.paginationToken;
  } while (paginationToken !== null);
  return transactions;
}

/** A keypair's unspent SOL in `transactions`, as inputs a program transaction can spend. */
export async function spendableSol(
  client: SprClient,
  owner: ShieldedKeypair,
  transactions: readonly IndexedShieldedTransaction[],
  assets: AssetRegistry,
): Promise<ProgramWalletUtxo[]> {
  const wallet = new Wallet({ identity: owner.shieldedAddress(), registry: assets });
  const keys = LocalShieldedKeys.fromKeypair(owner);
  try {
    await decryptTransactions({ wallet, keys, transactions });
  } finally {
    keys.destroy();
  }
  return wallet
    .utxos()
    .filter((u) => !u.spent && u.utxo.asset === SOL_MINT)
    .map((u) =>
      toProgramWalletUtxo(u, { nullifierPublicKey: owner.nullifierPublicKey(), treeId: client.treeId, assets }),
    );
}

export const total = (utxos: readonly { utxo: { amount: bigint } }[]) => utxos.reduce((s, u) => s + u.utxo.amount, 0n);

const PADDING_ERRORS = new Set([
  "TRANSACTION_DESERIALIZE",
  "TRANSACTION_TRAILING_BYTES",
  "TRANSACTION_BAD_DISCRIMINATOR",
  "TRANSACTION_INVALID_LENGTH",
]);

/**
 * The funder's open escrows: outputs tagged with their escrow authority that
 * decrypt with their viewing key and whose committed terms match the UTXO
 * hash, minus those already spent.
 */
export function openEscrows(
  wasm: EscrowWasm,
  viewingKey: ViewingKey,
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  assets: AssetRegistry,
  treeId: number,
): DataUtxo<EscrowTerms>[] {
  const ownerTag = hex(authority.ownerTag());
  const recipientKey = viewingKey.publicKey().toBytes();
  const recipient = hex(recipientKey);
  const owner = authority.publicKey().toBytes();
  const nullifierPubkey = ProgramOwner.nullifierPublicKey();
  const nullifierKey = ProgramOwner.nullifierKey();
  const spent = new Set(transactions.flatMap((tx) => tx.nullifiers.map(hex)));
  const escrows = new Map<string, DataUtxo<EscrowTerms>>();
  try {
    for (const tx of transactions) {
      const { txViewingPublicKey, salt } = tx;
      if (txViewingPublicKey === undefined || salt === undefined) continue;
      tx.outputSlots.forEach((slot, slotIndex) => {
        if (hex(slot.viewTag) !== ownerTag) return;
        let frame: ReturnType<typeof decodeOutputData>;
        try {
          frame = decodeOutputData(slot.payload);
        } catch (error) {
          // Padding reuses the owner's tag and publishes random bytes.
          if (error instanceof TransactionError && PADDING_ERRORS.has(error.code)) return;
          throw error;
        }
        if (frame.encoding !== "encrypted" || frame.scheme !== EncryptedScheme.confidential) return;
        const { body } = frame;
        if (hex(body.slice(0, recipientKey.length)) !== recipient) return;
        const plaintext = decodeConfidential(
          viewingKey.decryptUtxo(body.slice(recipientKey.length), txViewingPublicKey, salt, slotIndex),
        );
        const utxoHash = slot.outputContext.hash;
        const escrow = wasm.escrowTermsDataUtxo({
          utxo: {
            owner,
            asset: { asset: assets.resolve(plaintext.assetId), assetId: plaintext.assetId },
            amount: plaintext.amount,
            blinding: plaintext.blinding,
            data: { records: [...plaintext.data.records()] },
          },
          nullifierPubkey,
          utxoHash,
          nullifier: nullifierKey.nullifier(utxoHash, plaintext.blinding),
          treeId,
          leafIndex: slot.outputContext.leafIndex,
        });
        if (!spent.has(hex(escrow.utxo.nullifier))) escrows.set(hex(utxoHash), escrow);
      });
    }
  } finally {
    nullifierKey.destroy();
  }
  return [...escrows.values()];
}

export type Circuit = "create" | "release" | "refund";

/** Proves a program transaction with the committed key for `circuit`. */
export function prove(wasm: EscrowWasm, circuit: Circuit, proofInputs: Uint8Array): Proof {
  const key = readFileSync(new URL(`${circuit}.pk`, KEYS));
  const digest = readFileSync(new URL(`${circuit}.pk.sha256`, KEYS), "utf8").trim().split(/\s+/)[0];
  if (digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`bad digest for ${circuit}.pk`);
  const checksum = Uint8Array.from(Buffer.from(digest, "hex"));
  const Prover = { create: wasm.CreateProver, release: wasm.ReleaseProver, refund: wasm.RefundProver }[circuit];
  const prover = Prover.fromKey(key, checksum);
  try {
    return prover.prove(proofInputs);
  } finally {
    prover.free();
  }
}

interface ProgramTransactInput {
  readonly client: SprClient;
  readonly payer: TransactionSigner;
  readonly authority: ProgramOwner;
  readonly proof: CompressedGroth16Proof;
  readonly transact: TransactInstructionData;
  readonly programId?: Address;
}

const signer = (
  account: TransactionSigner,
  role: AccountRole.READONLY_SIGNER | AccountRole.WRITABLE_SIGNER,
): AccountSignerMeta => ({ address: account.address, role, signer: account });

const proofBytes = (proof: CompressedGroth16Proof) => concat(bytes32(proof.a), bytes64(proof.b), bytes32(proof.c));

async function programTransact(
  input: ProgramTransactInput,
  tag: number,
  args: Uint8Array,
  accounts: readonly AccountMeta[],
  ownerSigners: readonly TransactionSigner[],
): Promise<Instruction> {
  const sppAccounts = await transactCpiAccounts({
    payer: input.payer,
    inputTree: input.client.tree,
    outputTree: input.client.tree,
    ownerSigners,
    data: input.transact,
    signerPdas: [input.authority.pda],
  });
  return {
    programAddress: input.programId ?? ESCROW_PROGRAM_ID,
    accounts: [...accounts, ...sppAccounts],
    data: concat(Uint8Array.of(tag), args, encodeTransactInstructionData(input.transact)),
  };
}

/** Create: the funder escrows their tokens; the escrow is encrypted to `viewingPublicKey`. */
export function createInstruction(
  input: ProgramTransactInput & Readonly<{ funder: TransactionSigner; viewingPublicKey: X25519PublicKey }>,
): Promise<Instruction> {
  return programTransact(
    input,
    TAG.create,
    concat(proofBytes(input.proof), input.viewingPublicKey.toBytes()),
    [signer(input.funder, AccountRole.READONLY_SIGNER)],
    // The funder owns the spent inputs, so the pool's proof binds them as an
    // owner signer ahead of the escrow authority PDA.
    [input.funder],
  );
}

/**
 * Release: `approvers` sign, in the order the proof's `signers` lists them;
 * the program reads them as the accounts after the funder.
 */
export function releaseInstruction(
  input: ProgramTransactInput &
    Readonly<{ funder: Address; approvers: readonly TransactionSigner[]; deadline: bigint }>,
): Promise<Instruction> {
  return programTransact(
    input,
    TAG.release,
    concat(proofBytes(input.proof), u64le(input.deadline), Uint8Array.of(input.approvers.length)),
    [
      signer(input.payer, AccountRole.WRITABLE_SIGNER),
      { address: input.funder, role: AccountRole.READONLY },
      ...input.approvers.map((a) => signer(a, AccountRole.READONLY_SIGNER)),
    ],
    [],
  );
}

/** Refund: after the deadline, the funder takes back what is left. */
export function refundInstruction(
  input: ProgramTransactInput & Readonly<{ funder: TransactionSigner; deadline: bigint }>,
): Promise<Instruction> {
  return programTransact(
    input,
    TAG.refund,
    concat(proofBytes(input.proof), u64le(input.deadline)),
    [signer(input.payer, AccountRole.WRITABLE_SIGNER), signer(input.funder, AccountRole.READONLY_SIGNER)],
    [],
  );
}
