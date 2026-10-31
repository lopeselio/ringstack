# RingPay receipt v1

A receipt lets the **sender** of a private transfer prove the details of exactly one transaction to a third party, without disclosing any other balance or history.

Status: draft, verified on localnet (zolana v0.6.0-alpha). Wire format: `packages/core/src/receipt.ts`. Issue/open: `packages/core/src/receipt-open.ts`. End-to-end: `pnpm --filter @ringstack/core receipt:e2e`.

## Key material

Each private transaction has a **transaction viewing key** (X25519), derived by the sender:

```
txKey = senderViewingKey.transactionViewingKey(firstNullifier)
```

`firstNullifier` is the nullifier of the transaction's first input (it also seeds output blindings). It is public: the indexer returns it as `tx.nullifiers[0]`, so the sender can issue a receipt from the signature alone, at any time after sending. The transaction publishes `txKey.publicKey()` onchain, and every output slot is encrypted with it.

`txKey` decrypts **only that transaction's slots**. It reveals nothing about the sender's viewing key, other transactions, or balances.

SDK (`@heliuslabs/zolana` 0.6.0-alpha):
- `ViewingKey.transactionViewingKey(firstNullifier)` / `withTransactionKey(keys, firstNullifier, fn)`
- `ViewingKey.secretBytes()` → 32 bytes, `ViewingKey.fromBytes(bytes)`
- `ViewingKey.decryptSlotEphemeral(recipientViewingPk, ciphertext, salt, slotIndex)`
- `decryptConfidentialAsSender(txKey, body, salt, slotIndex)`

## Wire format

```
ringrcpt1:<base64url(body)>

body (106 bytes):
  u8   version        = 1
  u8   cluster        0 localnet | 1 devnet | 2 mainnet
  [64] signature      transaction signature
  [32] txViewingKey   X25519 secret
  u64  slot (LE)      landed slot, 0 = unknown
```

Share as `https://<verifier>/r#ringrcpt1:...`. The **fragment** keeps the key out of server logs.

## Issuing (sender)

1. `tx = getShieldedTransactionsBySignature(signature)`.
2. `txKey = senderViewingKey.transactionViewingKey(tx.nullifiers[0])`.
3. Require `txKey.publicKey() == tx.txViewingPublicKey`, otherwise the caller is not the sender.
4. Encode `{cluster, signature, txKey.secretBytes(), tx.slot}`.

## Verification algorithm

1. Decode the receipt.
2. `getShieldedTransactionsBySignature(signature)` on the cluster's indexer. Require the returned transaction's signature to equal the receipt's.
3. Check `X25519(txViewingKey).publicKey == tx.txViewingPublicKey`. If they differ, reject.
4. For each output slot `i`:
   - Decode the output data frame. Skip slots that are not `encrypted` with scheme `confidential` or `ringConfidential`.
   - The body is `recipientViewingPk (33 bytes) || ciphertext`. The recipient key is embedded, so **no registry lookup is needed to decrypt**.
   - `plaintext = decodeConfidential(txKey.decryptSlotEphemeral(recipientViewingPk, ciphertext, salt, i))`. Padding slots fail to decrypt and are skipped.
   - The plaintext gives the asset id, amount, blinding and data. `data.memo()` is the output's memo, if any.
5. **Commitment check** (optional per output). If the verifier knows the full shielded address of the slot's recipient (signing key, nullifier key, viewing key), it rebuilds the UTXO and requires `utxo.hash(nullifierPk, treeId) == outputContext.hash`. Results:
   - `verified`: the amount and asset are bound to the onchain commitment.
   - `mismatch`: the sender encrypted something other than what was committed. Reject.
   - `unchecked`: the recipient's address is unknown. The plaintext is still authentic sender data (the ciphertext is bound by `external_data_hash`), but not proven to match the commitment.
6. Display each output: recipient, asset, amount, memo, check result. An output whose recipient key is the sender's own is change. An all-zero memo (the padding `signTransferWithMemos` gives outputs without one) is shown as no memo.

For RingPay the verifier is typically the merchant, or anyone holding the payment request, so the merchant's address is known and the payment output is `verified`.

## Trust notes

- **Amount, asset, and recipient** are bound by the output commitment when the commitment check runs (step 5).
- **Memo** rides inside each output's confidential plaintext (a `Data` record). It is *not* in the commitment, so a `verified` result does not cover it, but its ciphertext is covered by `external_data_hash`, which the proof covers and the program recomputes. The memo is therefore authentic sender data.
- The key holder can decrypt the transaction forever. A receipt is a permanent disclosure of that one transaction.
- Only the sender can produce a receipt (it needs the sender's viewing key). Recipients can prove receipt of funds with their own outputs; that is out of scope for v1.

## Notes

- X25519 clamps the secret key (it clears the low 3 bits of byte 0, among other bits), so a few different 32-byte strings act as the same key. This is harmless: they all decrypt exactly the same transaction.

## Open items

- Whether to embed the recipient's full shielded address in the receipt (larger link, but every output becomes `verified` without outside knowledge).
