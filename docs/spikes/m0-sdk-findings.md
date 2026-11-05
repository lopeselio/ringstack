# Milestone 0 SDK checks

Date: 2026-10-31 · Sources: `helius-labs/zolana@v0.6.0-alpha` (8ae430a), `@heliuslabs/zolana@0.6.0-alpha` (npm), `helius-labs/zolana-examples@main`.

## Versions

| Artifact | Version | Notes |
|---|---|---|
| zolana GitHub release | `v0.6.0-alpha` (2026-10-28) | Prebuilt CLI, prover, Photon for darwin-arm64 + linux-x64 |
| npm `@heliuslabs/zolana` | `0.6.0-alpha` pinned; `0.7.0-alpha` exists (tag `alpha`), `latest` is still 0.5.0 | 0.6 and 0.7 both target `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW` |
| Node | ≥ 24 (SDK `engines`) | `.nvmrc` = 24 |

**Decision:** pin `0.6.0-alpha` to match the release binaries `zolana dev start` downloads. Revisit 0.7 once a matching GitHub release ships.

## Check 1: receipts (transaction viewing key): ✅ supported

- Each transaction has its own key: `ViewingKey.transactionViewingKey(firstNullifier)`.
- Export/import: `secretBytes()` / `ViewingKey.fromBytes()`.
- Decrypt one slot: `decryptSlotEphemeral(recipientViewingPk, ciphertext, salt, slotIndex)`, or `decryptConfidentialAsSender(txKey, body, salt, slotIndex)`.
- Spec drafted: [spec/receipt.md](../../spec/receipt.md). Codec implemented and tested.
- **Verified on localnet (2026-11-01)** with `pnpm --filter @ringstack/core receipt:e2e`: the sender issues a 152-character receipt, and a verifier decrypts the payment and change outputs and recomputes both commitments (`verified`). A third party can't issue a receipt, a tampered key is rejected, and the receipt doesn't open a different transaction.
- `firstNullifier` = `tx.nullifiers[0]` from the indexer, so a receipt can be issued later from the signature alone.
- Each confidential slot body embeds the recipient's viewing key (`pk(33) || ciphertext`), so verifiers need no registry lookup to decrypt.
- The SDK's sender-side helpers (`decryptConfidentialAsSender`, `confidentialUtxo`) are not exported, so `receipt-open.ts` rebuilds them from public exports (`decodeOutputData`, `decodeConfidential`, `ViewingKey.decryptSlotEphemeral`, `Utxo`).

## Check 2: payroll batching: ✅ supported (high-level)

- `createMultiTransfer({ wallet, payer, asset, payments: [{recipient, amount}] })`, with each payment as its own output, in order.
- Limit: `MAX_TRANSFER_PAYMENTS = max(shape.outputs) - 1` = **15** payees per transaction (16 outputs minus change).
- The SDK picks the shape automatically; no need to force a variant.
- `TransferDestination = Address | ShieldedAddress`: plain addresses are resolved via the registry.
- `createSplit({ wallet, payer, asset, parts })` pre-splits treasury UTXOs so batches can run concurrently.

## Memos: ✅ works via prepare/finalize (verified on localnet)

- High-level `createTransfer` / `createMultiTransfer` and `ConfidentialTransfer#send` take **no memo**.
- `deposit` accepts `memo`. For transfers, memos go through `ProofOutputUtxo.withMemo(bytes)`.
- A memo is a `Data` record (`kind: "memo"`) inside the output's **confidential plaintext**, so only the owner and transaction-key holders read it. It is **not** in the UTXO commitment; its ciphertext is bound by `external_data_hash`.
- Recipe (`core/src/memo.ts` `signTransferWithMemos`): `transfer.prepare()` → map `prepared.outputs` to `output.withMemo(m)` → `encodeConfidentialSlots(outputs, assets, txKey, salt)` → `prepared.finalize({ txViewingPublicKey, salt, payload })`. `finalize` hashes the original outputs, which is fine because the memo does not change the commitment. All public exports.
- Recipient: `decryptToBalances(...).balance(mint).utxos[i].data.memo()`. Receipt: `openReceipt` returns `memo` per output.
- **Length leak:** a memo lengthens its slot ciphertext (32-byte memo: 124-byte slot payload vs 89 without). Memos are fixed-width (`MEMO_LENGTH = 32`, zero-padded) so their length reveals nothing about the content, but the memo slot is distinguishable from the others. Padding the other outputs with zero memos would hide that, but strands them for SDK wallets (see below), so core does not. Ask upstream for memo-aware plain-UTXO rules, after which padding can return.
- Alternative: `withUtxoData(data, dataHash)` is committed, but SPP does not check `dataHash`, so readers must recompute it.
- **⚠️ Memo UTXOs are not "plain" to the SDK.** `isPlainUtxo` requires `utxo.data.isEmpty()`, and the SDK's default transfer, withdrawal and merge selection only take plain UTXOs. A received memo UTXO shows in `wallet.balance()` but `buildTransferTransaction` / `buildWithdrawalTransaction` / `buildMergeTransaction` skip it (`WALLET_INSUFFICIENT_BALANCE` with `available: 0` when it is all you hold). It spends fine through `ConfidentialTransfer` (verified on localnet), which `RingSession.transfer` now falls back to.
  - Consequence 1: `signTransferWithMemos` no longer pads other outputs with zero memos (that stranded the sender's change). So the memo slot is longer than the change slot (124 vs 89 bytes for a 32-byte memo), revealing which output carries the memo.
  - Consequence 2: withdrawing and merging memo UTXOs need our own lower-level paths, now in `RingSession` (verified on localnet in `session:e2e`):
    - **Withdraw (SOL):** `ConfidentialTransfer.withdraw(SOL_MINT, amount, WithdrawalTarget.sol(...))` plus `transactInstruction({ withdrawal: TransactWithdrawal.sol(...) })`. SPL needs the SPL interface PDA and bump, which the SDK keeps internal; not supported yet.
    - **Merge:** `buildMergeTransaction({ inputs })` skips the selection filter, but the merge builder re-checks and throws `TRANSACTION_MERGE_INPUT_HAS_DATA` for any non-empty `data`. Since the memo is outside the commitment, a memo UTXO rebuilt without its memo has the same hash, so `Merge.fromKeypair(keypair, strippedInputs)` → `client.proveMerge` → `client.assembleAuthorizedMergeTransaction` merges them; the program accepts it and the merged output is plain. `Merge.fromKeypair` needs the full keypair; ringd's key-file auto-merge will need the `new Merge({...})` form.
  - Upstream ask: treat memo-only data as plain in `isPlainUtxo`, the merge builder's `hasData`, and Rust `is_plain` (the memo is outside the commitment, so the proof is unaffected). Filed as [helius-labs/zolana#543](https://github.com/helius-labs/zolana/issues/543). Our fallbacks in `RingSession` can go once it ships.
- Localnet: `pnpm --filter @ringstack/core memo:e2e` (recipient reads `order:…`, receipt shows it next to a `verified` amount, change carries no memo).

## Wallet helpers: ✅ verified on localnet

- The SDK's `build*Transaction` functions (`Registration`, `SetMergeEncryption`, `Deposit`, `Transfer`, `Withdrawal`, `Merge`) return compiled kit transactions. Sign with `signTransactionWithSigners`, send, `client.confirmTransaction` for the slot, then `syncWallet({ requireSlot })`.
- `core/src/session.ts` `RingSession` wraps that loop per identity; memo transfers go through `signTransferWithMemos` with largest-first input selection from `wallet.utxos()` (capped at 8 inputs).
- Registration is idempotent: `buildRegistrationTransaction` returns `undefined` when the record already holds the same keys.
- **Merging needs the opt-in even for your own UTXOs**: `buildMergeTransaction` rejects unless the owner's registry record has `mergeEncryption = PoseidonCtrV1` (`buildSetMergeEncryptionTransaction`). New records start `Disabled`. With it enabled, anyone may merge for the owner (that is what ringd auto-merge will use).
- Localnet: `pnpm --filter @ringstack/core session:e2e` (register ×2, deposit 20M + 30M, enable merge, merge to 1 UTXO, transfer 10M + 5M with memo by Solana address, withdraw 4M to a fresh public address).

## Merging without the spending key: ✅ verified on localnet

- Answers the ringd idea doc's open question: a merge needs the owner's **nullifier key** (to spend the inputs) and shielded address, plus a prover (`LocalKeys.fromKeys({ address, viewingKeys, nullifierKey })`). The owner's Ed25519 key is not involved, and the only transaction signer is the fee payer given to `client.assembleAuthorizedMergeTransaction({ proved, feePayer, userRecord })`.
- The owner's registry record must have `mergeEncryption = PoseidonCtrV1`; anyone can then merge for them.
- `Merge.fromKeypair(keypair, inputs)` reads only `keypair.shieldedAddress()` and `keypair.nullifierKey()` (and destroys the key it gets), so `core/src/merge.ts` `buildMerge` passes a view of `{ address, nullifierKey }` instead of a full keypair. This leans on SDK internals; recheck on upgrades.
- `ringd e2e`: three memo payments merged into one plain UTXO from the key file and a separate fee payer; the owner's SOL balance was unchanged.

## Upgrade to zolana 0.8 (2026-11-05)

- Devnet moved to v0.7/v0.8 (finalized ceremony proving keys; per-tree fees). A 0.6.0-alpha client's attestation to the Devnet-e prover is refused (`HTTP 400 tee_required`), so 0.6 cannot prove on devnet.
- 0.8 needs no code changes to compile here. Devnet config becomes one Helius RPC URL (indexer and prover under `/v1/spr`) plus `proverTee: SignedTeePolicy.forNetwork("devnet")`, replacing our pinned Nitro measurements.
- 0.8 checks the prover's proving keys against its pinned catalog, so it refuses the v0.6 local prover (`transfer_confidential_1_2` hash mismatch). zolana 0.8 publishes no CLI/prover binaries; zolana-examples builds them from source. Integration tests moved to devnet (`.github/workflows/devnet.yml`).
- The internals our workarounds rely on are unchanged in 0.8: `isPlainUtxo` still rejects memos (#543 open), `Merge.fromKeypair` reads only the address and nullifier key, and the slot cipher labels (`TSPP/hpke/`, `TSPP/tx`) are the same.
- Every suite passes on devnet; see [devnet.md](../devnet.md).

## Localnet

- `zolana dev start` downloads programs, the account snapshot, the prover, and Photon from the pinned release, sha256-verified against a lockfile embedded in the CLI, and caches them in `~/.config/zolana/cache/<tag>/`.
- The release prover predates indexed proofs, so clients on a release localnet use `proofDataSource: "client"` (set in `core/config.ts`).
- Ports: RPC 8899, indexer 8784, prover 3001.

## Devnet endpoints (from zolana-examples)

- RPC `https://devnet.helius-rpc.com/?api-key=…`
- Indexer (Devnet-e Photon) `https://d34xe1hqb2ibg2.cloudfront.net`
- Prover (attested Nitro) `https://dd73hh473h6ha.cloudfront.net`, with PCRs pinned in `devnet-e-tee-policy.json` (vendored into core). The SDK's built-in default policy still pins the older Devnet-d enclave.

## Other useful SDK surface found

`isWalletRegistered`, `resolveShieldedRecipient`, `buildRegistrationTransaction`, `buildSetMergeEncryptionTransaction`, `createMerge` / `buildMergeTransaction`, `syncWallet` / `syncPersistedWallet` / `beginSyncSession` (ringd), `getPrivateTokenBalances`, `getPrivateTransactions`, `walletSnapshotCipher` (encrypted local persistence).
