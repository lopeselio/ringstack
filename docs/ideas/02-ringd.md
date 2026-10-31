# 2. ringd: self-hosted sync daemon with private webhooks

**Status:** Selected · **Type:** Client-only (Rust or TS service) · **Used by:** [RingPay](01-ringpay.md), [payroll CLI](04-payroll-cli.md)

## Problem

Apps that receive private payments (merchants, exchanges, payroll operators, bots) need to know **when** they get paid. Today the options are:

- **Delegated decryption**: give an RPC provider your viewing key. Convenient, but the provider sees your full balance and history.
- **Local decryption** inside every app: each backend re-implements sync, caching, backfills, and UTXO hygiene.

Nothing provides "Stripe-style webhooks" for private balances where the viewing key never leaves your machine.

## Solution

A small daemon you run next to your backend:

```
            +-------------------- ringd --------------------+
 Photon  -> | poller -> decryptor -> store (sqlite) -> events | -> webhooks (HMAC-signed)
 indexer    |              ^  viewing key (local only)     |  -> local JSON API
 (Helius or |   merger (auto-merge UTXOs, no signature)    |  -> CLI
  self-host)+-----------------------------------------------+
```

- **Sync:** poll `getShieldedTransactionsByTags` for each watched shielded address, decrypt locally, persist UTXOs and history. Backfill on start or after a gap (the docs list unlock, resume, reconnect, and stream gap as backfill points).
- **Events:** `payment.received`, `payment.sent`, `utxo.merged`, `balance.changed`. Each includes the decrypted memo (so RingPay can match `order`). Delivered as HMAC-signed webhooks with retry and an idempotency key (tx signature + output index).
- **Local API:** `GET /balances`, `GET /history?since=`, `GET /utxos`, `POST /watch`.
- **Auto-merge:** when an address's UTXO count passes a threshold (e.g. 30), submit merge transactions. Merges need no user signature, so the daemon never needs the spending key.
- **Key handling:** the daemon holds **viewing + nullifier keys only** (read-only). It **never** holds the Ed25519 spending key. Key file encrypted at rest.
- **Indexer choice:** works against the Helius endpoint or a self-hosted Photon indexer (permissionless) for maximum privacy.

## Deliverables

- `ringd` binary + Docker image.
- Config: `ringd.toml` (rpc/indexer URLs, watched addresses, webhook URLs, merge threshold).
- `ringd-client` TS package (typed webhook verification + API client).
- Example: Express/Hono handler that verifies the webhook signature.

## Helius primitives used

Photon indexer RPC, view tags, local decryption via the `ViewingKey` interface, merge instruction with `MergeEncryptionScheme::PoseidonCtrV1`.

## MVP (localnet → devnet)

1. Watch one address, decrypt, print new incoming payments.
2. SQLite persistence + restart/backfill correctness.
3. Webhook delivery with HMAC + retries.
4. Auto-merge.

## Risks / open questions

- Whether merge submission needs the nullifier key, or whether merges can be built from the viewing key alone. Confirm in the spec.
- No streaming API known, so polling interval vs RPC credits is a trade-off. Investigate whether Photon has subscriptions.
- Language choice: the Rust client exposes `sync_wallet_with_config` and the decrypt APIs directly. Leaning **Rust** for the daemon and TS for client libraries.
