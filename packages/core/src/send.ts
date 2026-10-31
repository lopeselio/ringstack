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
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import type { createZolanaClient } from "@heliuslabs/zolana";

export type ZolanaClient = Awaited<ReturnType<typeof createZolanaClient>>;

export interface ConfirmedTransaction {
  readonly signature: Signature;
  /** Landed slot; gates indexer reads (`atSlot`). */
  readonly slot: bigint;
}

export interface SendOptions {
  readonly computeUnitLimit?: number;
}

/**
 * Sign, send, and confirm instructions as a v1 transaction.
 * Adapted from helius-labs/zolana-examples (Apache-2.0).
 */
export function sendAndConfirmFactory(
  client: ZolanaClient,
  feePayer: TransactionSigner,
  { computeUnitLimit = 450_000 }: SendOptions = {},
): (instructions: readonly Instruction[]) => Promise<ConfirmedTransaction> {
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });

  return async (instructions) => {
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
    await send(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);
    const slot = await client.confirmTransaction(signature);
    return { signature, slot };
  };
}
