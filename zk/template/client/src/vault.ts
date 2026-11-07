/**
 * Client for the template vault program: build each instruction's program
 * transaction with the wasm circuits, prove it with the committed keys, get
 * the pool's proof from the SDK's prover, and send one instruction that
 * verifies and CPIs. Adapted from upstream's timelock escrow TypeScript client
 * (helius-labs/zolana, Apache-2.0).
 */
import { readFileSync } from "node:fs";

import { SOL_MINT } from "@heliuslabs/spr";
import { atSlot, type PaginationToken, type SprClient } from "@heliuslabs/spr/client";
import { encodeTransactInstructionData, type TransactInstructionData } from "@heliuslabs/spr/interface";
import { bytes32, bytes64, type ShieldedKeypair, type ViewingKey, type X25519PublicKey } from "@heliuslabs/spr/keypair";
import {
  ProgramOwner,
  toProgramWalletUtxo,
  transactCpiAccounts,
  type ProgramWalletUtxo,
} from "@heliuslabs/spr/program";
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

import type { CompressedGroth16Proof, DataUtxo, Proof, TemplateWasm, VaultTerms } from "./wasm.ts";

/** The program this client talks to: `declare_id!` in zk/template/src/lib.rs. */
export const TEMPLATE_PROGRAM_ID = address("3bzWnoteJaH7kD6Jron7Lb1ABfQxLGSqcEzRr3Zy6cAi");
/** Output slot of the vault UTXO in a lock transaction. */
export const VAULT_OUTPUT_SLOT = 1;
/** `VaultError::NotYetUnlocked`. */
export const NOT_YET_UNLOCKED = 9005;

const LOCK_TAG = 0;
const RELEASE_TAG = 1;
const VAULT_AUTHORITY_SEED = "vault_authority";
const TRANSACT_COMPUTE_UNIT_LIMIT = 1_400_000;
const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;
const KEYS = new URL("../../keys/", import.meta.url);
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

/** Sends version-1 transactions with the compute budget a proof-carrying transact needs. */
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

/** The PDA that owns a creator's vaults. */
export function vaultAuthority(creator: Address, programId: Address = TEMPLATE_PROGRAM_ID): Promise<ProgramOwner> {
  return ProgramOwner.find([VAULT_AUTHORITY_SEED, addressEncoder.encode(creator)], programId);
}

/**
 * Every transaction tagged for the creator or their vault authority, as of
 * `slot`: all pages, so a busy creator's older vaults are not missed.
 */
export async function creatorTransactions(
  client: SprClient,
  creator: ShieldedKeypair,
  authority: ProgramOwner,
  slot: bigint,
): Promise<readonly IndexedShieldedTransaction[]> {
  const tags = [creator.shieldedAddress().confidentialViewTag(), authority.ownerTag()];
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

/** The creator's unspent SOL, as inputs a program transaction can spend. */
export async function spendableSol(
  client: SprClient,
  creator: ShieldedKeypair,
  transactions: readonly IndexedShieldedTransaction[],
  assets: AssetRegistry,
): Promise<ProgramWalletUtxo[]> {
  const wallet = new Wallet({ identity: creator.shieldedAddress(), registry: assets });
  const keys = LocalShieldedKeys.fromKeypair(creator);
  try {
    await decryptTransactions({ wallet, keys, transactions });
  } finally {
    keys.destroy();
  }
  return wallet
    .utxos()
    .filter((u) => !u.spent && u.utxo.asset === SOL_MINT)
    .map((u) =>
      toProgramWalletUtxo(u, { nullifierPublicKey: creator.nullifierPublicKey(), treeId: client.treeId, assets }),
    );
}

const PADDING_ERRORS = new Set([
  "TRANSACTION_DESERIALIZE",
  "TRANSACTION_TRAILING_BYTES",
  "TRANSACTION_BAD_DISCRIMINATOR",
  "TRANSACTION_INVALID_LENGTH",
]);

/**
 * The creator's open vaults: outputs tagged with their vault authority that
 * decrypt with their viewing key, whose committed terms match the UTXO hash,
 * minus those already spent. The authority's tag and the creator's viewing key
 * are public, so a forged output that does not decrypt or does not match its
 * commitment is skipped, not thrown on; `onSkipped` sees each one.
 */
export function openVaults(
  wasm: TemplateWasm,
  viewingKey: ViewingKey,
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  assets: AssetRegistry,
  treeId: number,
  onSkipped?: (signature: string, slot: number, error: unknown) => void,
): DataUtxo<VaultTerms>[] {
  const ownerTag = hex(authority.ownerTag());
  const recipientKey = viewingKey.publicKey().toBytes();
  const recipient = hex(recipientKey);
  const owner = authority.publicKey().toBytes();
  const nullifierPubkey = ProgramOwner.nullifierPublicKey();
  const nullifierKey = ProgramOwner.nullifierKey();
  const spent = new Set(transactions.flatMap((tx) => tx.nullifiers.map(hex)));
  const vaults = new Map<string, DataUtxo<VaultTerms>>();
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
        let vault: DataUtxo<VaultTerms>;
        try {
          const plaintext = decodeConfidential(
            viewingKey.decryptUtxo(body.slice(recipientKey.length), txViewingPublicKey, salt, slotIndex),
          );
          const utxoHash = slot.outputContext.hash;
          vault = wasm.vaultTermsDataUtxo({
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
        } catch (error) {
          onSkipped?.(String(tx.txSignature), slotIndex, error);
          return;
        }
        if (!spent.has(hex(vault.utxo.nullifier))) vaults.set(hex(vault.utxo.utxoHash), vault);
      });
    }
  } finally {
    nullifierKey.destroy();
  }
  return [...vaults.values()];
}

/** Proves a program transaction with the committed key for `circuit`. */
export function prove(wasm: TemplateWasm, circuit: "lock" | "release", proofInputs: Uint8Array): Proof {
  const key = readFileSync(new URL(`${circuit}.pk`, KEYS));
  const digest = readFileSync(new URL(`${circuit}.pk.sha256`, KEYS), "utf8").trim().split(/\s+/)[0];
  if (digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`bad digest for ${circuit}.pk`);
  const checksum = Uint8Array.from(Buffer.from(digest, "hex"));
  const prover = circuit === "lock" ? wasm.LockProver.fromKey(key, checksum) : wasm.ReleaseProver.fromKey(key, checksum);
  try {
    return prover.prove(proofInputs);
  } finally {
    prover.free();
  }
}

interface ProgramTransactInput {
  readonly client: SprClient;
  readonly creator: TransactionSigner;
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
    payer: input.creator,
    inputTree: input.client.tree,
    outputTree: input.client.tree,
    ownerSigners,
    data: input.transact,
    signerPdas: [input.authority.pda],
  });
  return {
    programAddress: input.programId ?? TEMPLATE_PROGRAM_ID,
    accounts: [...accounts, ...sppAccounts],
    data: concat(Uint8Array.of(tag), args, encodeTransactInstructionData(input.transact)),
  };
}

/** Lock: the creator spends their UTXOs into a vault their authority PDA owns. */
export function lockInstruction(
  input: ProgramTransactInput & Readonly<{ viewingPublicKey: X25519PublicKey }>,
): Promise<Instruction> {
  return programTransact(
    input,
    LOCK_TAG,
    concat(proofBytes(input.proof), input.viewingPublicKey.toBytes()),
    [signer(input.creator, AccountRole.READONLY_SIGNER)],
    // The creator owns the spent inputs, so the pool's proof binds them as an
    // owner signer ahead of the vault authority PDA.
    [input.creator],
  );
}

/** Release: after `unlock`, the vault goes back to the creator. */
export function releaseInstruction(input: ProgramTransactInput & Readonly<{ unlock: bigint }>): Promise<Instruction> {
  return programTransact(
    input,
    RELEASE_TAG,
    concat(proofBytes(input.proof), u64le(input.unlock)),
    [signer(input.creator, AccountRole.WRITABLE_SIGNER), signer(input.creator, AccountRole.READONLY_SIGNER)],
    [],
  );
}
