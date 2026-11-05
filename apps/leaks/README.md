# Pool leak report

A static page that shows, in aggregate, how many withdrawals from the shielded pool could be traced from public data, why, and how to avoid it. Live at **https://lopeselio.github.io/ringstack/leaks/**.

The page reads one file, `stats.json`, produced by [`leakscan stats`](../../packages/leakscan). It shows totals only: no addresses and no transactions.

## How it's published

The [docs workflow](../../.github/workflows/docs.yml) runs daily. It restores yesterday's event cache, scans devnet for new deposits and withdrawals, writes `stats.json`, and deploys the page to `/leaks/`. The event cache contains addresses, so it lives only in the private Actions cache and is never published.

## Run locally

```bash
ZOLANA_NETWORK=devnet pnpm --filter @ringstack/leakscan leakscan scan --days 3
pnpm --filter @ringstack/leakscan leakscan stats --out "$PWD/apps/leaks/public/stats.json"
pnpm --filter @ringstack/leaks dev
```
