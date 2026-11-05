# ringd

A self-hosted watcher for private payments ([idea doc](../../docs/ideas/02-ringd.md)). It polls the indexer for the wallets you configure, decrypts locally, and records each payment as an event in SQLite. The viewing key never leaves the machine.

**Status:** watch → decrypt → SQLite → events → HMAC-signed webhooks with retry, and auto-merge. The local HTTP API is next.

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
pnpm --filter @ringstack/ringd ringd deliveries --config ringd.toml [--webhook orders] [--status failed]
pnpm --filter @ringstack/ringd ringd deliveries retry --webhook orders --config ringd.toml
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

## Webhooks

```toml
[[webhook]]
name = "orders"
url = "https://shop.example/hooks/ringd"   # http:// is accepted only for localhost
secret_env = "RINGD_WEBHOOK_SECRET"        # the secret comes from the environment, ≥ 16 chars
events = ["payment.received"]              # optional filter
wallets = ["shop"]                         # optional filter

[delivery]                                 # optional, these are the defaults
timeout_secs = 10
max_attempts = 12
retry_base_secs = 5                        # wait base × 2^(attempt−1) between tries
retry_max_secs = 3600
```

Each delivery is a `POST` of one event as JSON with these headers:

| Header | Value |
|---|---|
| `ringd-id` | `<wallet>:<event id>`: the same on every retry. Dedupe on it. |
| `ringd-timestamp` | Unix seconds when this attempt was signed |
| `ringd-signature` | `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>` |

- **Success** is any 2xx. Anything else, including timeouts, connection errors and redirects (which are never followed), is retried with backoff. After `max_attempts` the delivery is marked `failed`; `ringd deliveries retry --webhook <name>` puts failed ones back in the queue.
- **At least once:** a delivery can arrive more than once (for example, the receiver commits but the response is lost). Receivers must dedupe on `ringd-id`.
- **Ordering:** each webhook gets events oldest first, and a failure pauses that webhook until its retry is due. Other webhooks are unaffected. Order across retries is not guaranteed, so use `slot` if order matters.
- **Routing** happens when the event is recorded: a webhook added later does not receive older events.

Verify in your handler with [`@ringstack/ringd-client`](../../packages/ringd-client):

```ts
import { createServer } from "node:http";
import { verifyWebhook } from "@ringstack/ringd-client";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const { id, event } = verifyWebhook({
        body: Buffer.concat(chunks).toString("utf8"), // the raw body, before any JSON parsing
        headers: req.headers,
        secret: process.env.RINGD_WEBHOOK_SECRET!,
      });
      if (event.type === "payment.received" && event.memo?.startsWith("order:")) {
        await markOrderPaid(event.memo.slice(6), event.amount, id); // idempotent on `id`
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(8080);
```

## Auto-merge

Wallets that receive many payments accumulate many small UTXOs, and a spend can use at most a few dozen inputs. ringd can merge them for you, **without the spending key**:

```toml
[[wallet]]
name = "shop"
key_file = "./shop.ringd-key.json"
merge_threshold = 30            # merge once 30 spendable UTXOs of one asset pile up

[merge]
fee_payer = "./fee-payer.json"  # a Solana keypair holding only SOL for fees
max_inputs = 24                 # UTXOs per merge (2–24, default 24)
```

- A merge spends with the **nullifier key** (in the key file) and is proved with the viewing + nullifier keys. The only signer is the **fee payer**, a separate hot wallet with just enough SOL for fees, never the owner. The owner's balance and keys are untouched.
- The owner must opt in once, from their own wallet: `RingSession.setMerge(true)` (`buildSetMergeEncryptionTransaction` with `PoseidonCtrV1`). Until then ringd logs `merge skipped` once per run and leaves the wallet alone.
- Each cycle, after recording events, ringd merges the smallest UTXOs (up to `max_inputs`) of any asset at or over the threshold. The merge shows up as a `utxo.merged` event on the next cycle.
- **Memo payments are merged too.** The SDK's merge refuses UTXOs that carry a memo ([helius-labs/zolana#543](https://github.com/helius-labs/zolana/issues/543)); ringd rebuilds each one without its memo (the memo is outside the commitment, so the hash is unchanged) and merges through the lower-level builder. The merged output has no memo; the memo was already delivered in its `payment.received` event.

## How state works

- **Snapshot:** the SDK's wallet snapshot (UTXOs, history, sync cursors), sealed with a key derived from the viewing key (`keyedWalletSnapshotCipher`). It is saved only after a sync commits, so a restart resumes from the last committed cursors.
- **Events:** each cycle compares the wallet's full history to the `events` table and appends what is missing. A crash between saving the snapshot and appending events is repaired on the next cycle, and a restart never re-emits.
- **Deliveries:** one row per (webhook, event), written in the same transaction as the event, so an event is never recorded without its deliveries.

## Check on devnet

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json pnpm --filter @ringstack/ringd e2e
```

This covers a payment received before ringd started (reported once, `backfill`), a live payment with an order memo, an idle cycle and a restart with no duplicates, and the merchant spending elsewhere, which ringd reports as `payment.sent` with read-only keys. A second wallet that opted in gets three memo payments and is merged into one plain UTXO by ringd with only its key file and a separate fee payer (the owner's SOL balance does not change); the first wallet, over its threshold but not opted in, is skipped. A local receiver verifies every webhook. One endpoint fails twice and then succeeds on the same `ringd-id`, and an unreachable one ends `failed` and is requeued.
