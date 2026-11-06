/**
 * Merging a wallet's UTXOs without its spending key.
 *
 * A merge needs the owner's nullifier key (to spend the inputs) and shielded
 * address, a prover, and any fee payer; the owner's Ed25519 key is not
 * involved. The owner must have opted in with `setMerge(true)`
 * (`MergeEncryptionScheme.PoseidonCtrV1`).
 *
 * Memo UTXOs: the SDK's merge builder rejects inputs with non-empty data. A
 * memo is outside the commitment, so each input is rebuilt without its memo
 * (same hash) before going into the lower-level `Merge`.
 */
import { SOL_MINT, type NullifierKey, type ShieldedAddress, type ShieldedKeypair } from "@heliuslabs/spr";
import { getUserRecordAddress } from "@heliuslabs/spr/addresses";
import type { ProofAuthority } from "@heliuslabs/spr/client";
import { Merge, ProofInputUtxo } from "@heliuslabs/spr/transaction";
import type { Wallet } from "@heliuslabs/spr";
import { getAddressDecoder, type Address, type Transaction } from "@solana/kit";

import type { SprClient } from "./send.ts";
import { mergeEntries, withoutMemo } from "./utxos.ts";

/** What a merge needs from the owner: address and nullifier key. The key stays the caller's. */
export interface MergeAuthority {
  readonly address: ShieldedAddress;
  readonly nullifierKey: NullifierKey;
}

export interface BuildMergeInput {
  readonly client: SprClient;
  readonly wallet: Wallet;
  readonly authority: MergeAuthority;
  /** Proves the merge (e.g. `LocalKeys.fromKeys` over the viewing + nullifier keys). */
  readonly keys: ProofAuthority;
  /** Pays the fee and is the only signer. Need not be the owner. */
  readonly feePayer: Address;
  readonly asset?: Address;
  /** Default `MERGE_INPUT_COUNT` (24). */
  readonly maxInputs?: number;
}

export interface BuiltMerge {
  /** Unsigned; the fee payer signs it. */
  readonly transaction: Transaction;
  readonly inputs: number;
  readonly amount: bigint;
}

/** The Solana address that owns a shielded address (its Ed25519 signing key). */
export function ownerAddress(address: ShieldedAddress): Address {
  return getAddressDecoder().decode(address.signingPublicKey.ed25519());
}

export async function buildMerge(input: BuildMergeInput): Promise<BuiltMerge> {
  const asset = input.asset ?? SOL_MINT;
  const entries = mergeEntries(input.wallet, asset, input.maxInputs);
  const inputs = entries.map((e) => ProofInputUtxo.fromNullifierKey(withoutMemo(e.utxo), input.authority.nullifierKey));
  // Merge.fromKeypair reads only shieldedAddress() and nullifierKey() (and
  // destroys the key it gets), so a view of the authority is enough.
  const view = {
    shieldedAddress: () => input.authority.address,
    nullifierKey: () => input.authority.nullifierKey.clone(),
  } as unknown as ShieldedKeypair;
  const prepared = Merge.fromKeypair(view, inputs).prepare();
  const proved = await input.client.proveMerge({ prepared, keys: input.keys });
  const transaction = await input.client.assembleAuthorizedMergeTransaction({
    proved,
    feePayer: input.feePayer,
    userRecord: await getUserRecordAddress(ownerAddress(input.authority.address)),
  });
  return { transaction, inputs: entries.length, amount: entries.reduce((s, e) => s + e.utxo.amount, 0n) };
}
