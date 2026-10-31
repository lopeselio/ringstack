# RingPay receipt v1

A receipt lets the **sender** of a private transfer prove the details of exactly one transaction to a third party, without disclosing any other balance or history.

Status: draft. The wire format is implemented in `packages/core/src/receipt.ts`; verification is pending a localnet run (Milestone 1).

## Key material

Each private transaction has a **transaction viewing key** (X25519), derived by the sender:

```
txKey = senderViewingKey.transactionViewingKey(firstNullifier)
```

`firstNullifier` is the nullifier of the transaction's first input (it also seeds output blindings). The transaction publishes `txKey.publicKey()` onchain, and every output slot is encrypted with it.

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

## Verification algorithm

1. Decode the receipt.
2. `getShieldedTransactionsBySignature(signature, atSlot(slot))` on the cluster's indexer. Require the transaction to be finalized.
3. Check `X25519(txViewingKey).publicKey == tx.txViewingPublicKey`. If they differ, reject.
4. For each output slot `i` that has a ciphertext:
   - Resolve the slot owner's viewing public key (from the user registry, keyed by the slot's Solana owner / view tag).
   - `plaintext = txKey.decryptSlotEphemeral(ownerViewingPk, ciphertext_i, salt, i)`.
   - Decode the asset, amount, blinding, and memo.
   - Recompute the UTXO commitment and require it to equal the onchain output commitment for slot `i`.
5. Display each verified output: recipient, asset, amount, memo. Label the sender's change output as change.

## Trust notes

- **Amount, asset, and recipient** are bound by the output commitment (step 4).
- **Memo** is *not* in the commitment, but its ciphertext is covered by `external_data_hash`, which the proof covers and the program recomputes. Decrypting the onchain ciphertext is therefore authentic.
- The key holder can decrypt the transaction forever. A receipt is a permanent disclosure of that one transaction.
- Only the sender can produce a receipt (it needs the sender's viewing key). Recipients can prove receipt of funds with their own outputs; that is out of scope for v1.

## Open items

- Confirm how the indexer response exposes `txViewingPublicKey`, salt, and per-slot ciphertexts.
- Confirm how to obtain `firstNullifier` after sending (from the built transaction or the indexer response).
