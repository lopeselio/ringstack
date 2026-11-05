# ringd

A self-hosted watcher for private payments ([idea doc](../../docs/ideas/02-ringd.md)). It polls the indexer for the wallets you configure, decrypts locally, and records each payment as an event in SQLite. The viewing key never leaves the machine.

**Status:** M1 step 1 (watch → decrypt → SQLite → log). Webhooks, the local HTTP API and auto-merge come next.

## Keys: read-only by design

```bash
pnpm --filter @ringstack/ringd ringd keys export --keypair ~/.config/solana/id.json --out shop.ringd-key.json
```

The key file holds the **viewing key** (decrypts outputs), the **nullifier key** (detects spends) and the public shielded address. It never holds the Ed25519 spending key, so a leaked key file exposes the wallet's history and balance but cannot move funds. It is written with mode `0600` and is not encrypted at rest yet.

## Run

```bash
cp ringd.example.toml ringd.toml       # set network, wallets
pnpm --filter @ringstack/ringd ringd run --config ringd.toml          # poll until SIGINT/SIGTERM
pnpm --filter @ringstack/ringd ringd run --config ringd.toml --once   # one pass
pnpm --filter @ringstack/ringd ringd events --config ringd.toml [--wallet shop] [--after <seq>]
```

Logs are JSON lines. Each new event is logged as `{"msg":"event", "seq":…, …}`.

## Events

| `type` | When |
|---|---|
| `payment.received` | An inbound transfer or deposit |
| `payment.sent` | The wallet spent funds to someone else (detected via the nullifier key) |
| `utxo.merged` | A merge of the wallet's UTXOs |
| `wallet.activity` | Anything else (splits, self-transfers) |

```json
{
  "id": "4FKMsC…zrCw:2",
  "type": "payment.received",
  "wallet": "shop",
  "signature": "4FKMsC…zrCw",
  "slot": "48",
  "kind": "privateTransfer",
  "direction": "inbound",
  "asset": "11111111111111111111111111111111",
  "amount": "12500000",
  "memo": "order:1042",
  "backfill": false,
  "createdAt": "2026-11-05T10:00:00.000Z"
}
```

- `id` is `<signature>:<index>` from the SDK's stable history row id. With `wallet` it is the idempotency key: storage is unique on it, and webhook deliveries will carry it.
- `memo` is the decrypted memo on the received output ([memo.ts](../../packages/core/src/memo.ts)), for matching RingPay orders.
- `backfill: true` marks events found on a wallet's first sync, which is history from before ringd watched it.
- Amounts are base units as strings.

## How state works

- **Snapshot:** the SDK's wallet snapshot (UTXOs, history, sync cursors), sealed with a key derived from the viewing key (`keyedWalletSnapshotCipher`). It is saved only after a sync commits, so a restart resumes from the last committed cursors.
- **Events:** each cycle compares the wallet's full history to the `events` table and appends what is missing. A crash between saving the snapshot and appending events is repaired on the next cycle, and a restart never re-emits.

## Check on localnet

```bash
./scripts/localnet.sh && pnpm --filter @ringstack/ringd e2e
```

This covers a payment received before ringd started (reported once, `backfill`), a live payment with an order memo, an idle cycle and a restart with no duplicates, and the merchant spending elsewhere, which ringd reports as `payment.sent` with read-only keys.
