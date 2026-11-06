# Paid API demo

A pay-per-call API behind [`@ringstack/paywall`](../../packages/paywall): made-up weather forecasts at 0.0005 SOL per call, paid privately.

**Live on devnet:** https://ringstack-paywall-demo.azurewebsites.net (Azure App Service free tier, so the first call after it has been idle is slow). Pay it from an agent wallet:

```bash
AGENT_KEYPAIR=.devnet/agent.json ZOLANA_NETWORK=devnet \
  pnpm --filter @ringstack/paywall-demo call "https://ringstack-paywall-demo.azurewebsites.net/v1/forecast?city=Lisbon"
```

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

Call it with [`paidFetch`](../../packages/paywall), the [agent MCP server](../agent-mcp), or the `call` script, which pays from an agent wallet with a private balance:

```bash
AGENT_KEYPAIR=.devnet/agent.json ZOLANA_NETWORK=devnet \
  pnpm --filter @ringstack/paywall-demo call "http://localhost:8080/v1/forecast?city=Lisbon"
```

## Deploy (Azure App Service)

`pnpm --filter @ringstack/paywall-demo bundle` writes `dist/server.mjs`: one 6 MB file with the dependencies and the hasher WASM inlined, so the host needs no `node_modules` and no TypeScript at runtime. That matters on small plans. Azure's free F1 tier allows 60 CPU-minutes a day, and unpacking a 10,000-file `node_modules` used all of it.

```bash
mkdir -p deploy/dist && cp dist/server.mjs deploy/dist/
echo '{"type":"module","scripts":{"start":"node dist/server.mjs"}}' > deploy/package.json
(cd deploy && zip -qr ../app.zip .)
az webapp config set -g <group> -n <app> --startup-file "node dist/server.mjs"
az webapp deploy -g <group> -n <app> --src-path app.zip --type zip
```

App settings: `ZOLANA_NETWORK=devnet`, `API_KEY`, `VENDOR_KEY` (the read-only key file's JSON), `VENDOR_ADDRESS`, `PRICE`, `SCM_DO_BUILD_DURING_DEPLOYMENT=false`, `PORT=8080`. Only the vendor's read-only key goes to the host; its spending key stays offline.

## Check it on devnet

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json pnpm --filter @ringstack/paywall-demo e2e
```

This covers an unpaid call answered with a 402 challenge, then a private payment that is served. It also checks that a replayed signature is refused, that a payment for `/v1/forecast` cannot unlock `/v1/alerts`, and that the per-call, host and daily-budget limits refuse without moving funds. Finally, the vendor must have received exactly what the agent's ledger records.
