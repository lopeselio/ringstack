# Paid API demo

A pay-per-call API behind [`@ringstack/paywall`](../../packages/paywall): made-up weather forecasts at 0.0005 SOL per call, paid privately.

| Route | |
|---|---|
| `GET /` | Free: what it sells and how to pay |
| `GET /health` | Free |
| `GET /v1/forecast?city=…` | Paid |
| `GET /v1/alerts?city=…` | Paid |

## Run

The vendor needs a registered wallet. The server gets only its read-only key file (`ringd keys export`), so it can see payments but not move funds.

```bash
VENDOR_KEY_FILE=vendor.ringd-key.json VENDOR_ADDRESS=<vendor Solana address> \
ZOLANA_NETWORK=devnet pnpm --filter @ringstack/paywall-demo start      # :8080
```

Call it with [`paidFetch`](../../packages/paywall) or the [agent MCP server](../agent-mcp).

## Check it on devnet

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json pnpm --filter @ringstack/paywall-demo e2e
```

This covers an unpaid call answered with a 402 challenge, then a private payment that is served. It also checks that a replayed signature is refused, that a payment for `/v1/forecast` cannot unlock `/v1/alerts`, and that the per-call, host and daily-budget limits refuse without moving funds. Finally, the vendor must have received exactly what the agent's ledger records.
