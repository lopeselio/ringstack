import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signTransactionWithSigners,
  type Instruction,
  type Signature,
  type Transaction,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";
import type { createSprClient } from "@heliuslabs/spr";

export type SprClient = Awaited<ReturnType<typeof createSprClient>>;

export interface ConfirmedTransaction {
  readonly signature: Signature;
  /** Landed slot; gates indexer reads (`atSlot`). */
  readonly slot: bigint;
}

/** What is known once a transaction is signed, before it is sent. */
export interface SignedTransactionInfo {
  readonly signature: Signature;
  /** The transaction cannot land after this block height. */
  readonly lastValidBlockHeight: bigint;
}

export interface SendHooks {
  /**
   * Runs after signing and before sending. Persist the signature here to make
   * a crash between send and confirm recoverable without double-spending.
   */
  readonly beforeSend?: (info: SignedTransactionInfo) => void | Promise<void>;
}

export interface SendOptions {
  readonly computeUnitLimit?: number;
}

/**
 * Sign, send, and confirm instructions as a v1 transaction.
 * Adapted from helius-labs/zolana-examples (Apache-2.0).
 */
export function sendAndConfirmFactory(
  client: SprClient,
  feePayer: TransactionSigner,
  { computeUnitLimit = 450_000 }: SendOptions = {},
): (instructions: readonly Instruction[], hooks?: SendHooks) => Promise<ConfirmedTransaction> {
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });

  return async (instructions, hooks = {}) => {
    const { value: lifetime } = await client.solanaRpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) =>
          setTransactionMessageConfig(
            { computeUnitLimit, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 },
            m,
          ),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    const signature = getSignatureFromTransaction(signed);
    await hooks.beforeSend?.({ signature, lastValidBlockHeight: lifetime.lastValidBlockHeight });
    await send(signed, { commitment: "confirmed" });
    const slot = await client.confirmTransaction(signature);
    return { signature, slot };
  };
}

/**
 * Sign, send, and confirm a transaction the SDK already compiled
 * (`build*Transaction`). Every required signer must be in `signers`.
 */
export async function submitTransaction(
  client: SprClient,
  signers: readonly TransactionPartialSigner[],
  transaction: Transaction,
): Promise<ConfirmedTransaction> {
  const signed = await signTransactionWithSigners(signers, transaction);
  await sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc })(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  const slot = await client.confirmTransaction(signature);
  return { signature, slot };
}
