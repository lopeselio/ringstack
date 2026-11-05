# Agent wallet (MCP)

An MCP server that gives an AI agent a **private wallet for paying APIs**. When an API answers `402` with a `ringpay:` request, the agent pays it privately, within spend limits you set, and retries. Built on [`@ringstack/paywall`](../../packages/paywall).

## Tools

| Tool | What it does |
|---|---|
| `wallet_balance` | Private SOL balance, address, today's spend vs budget |
| `paid_fetch` | HTTP request; pays a RingPay 402 challenge within the policy and retries. Returns status, what was paid, and the body |
| `spending` | The spend ledger |

## Configure

| Variable | Default | |
|---|---|---|
| `AGENT_KEYPAIR` | (required) | Solana keypair file of the agent's wallet. It needs a private balance: deposit with `RingSession.deposit` |
| `ZOLANA_NETWORK` | `localnet` | Use `devnet`, with `API_KEY` in the repo's root `.env` |
| `AGENT_MAX_PER_CALL` | `0.001` | SOL per paid call |
| `AGENT_DAILY_BUDGET` | `0.01` | SOL per UTC day, tracked in the ledger |
| `AGENT_ALLOW_HOSTS` | any | Comma-separated hosts the agent may pay |
| `AGENT_LEDGER` | `~/.ringstack/agent-ledger.json` | Spend ledger (keeps budgets across restarts) |

## Add it to Claude Code

```bash
claude mcp add ringstack-agent \
  -e ZOLANA_NETWORK=devnet \
  -e AGENT_KEYPAIR=/path/to/agent.json \
  -e AGENT_DAILY_BUDGET=0.01 \
  -- pnpm -s --dir /path/to/ringstack --filter @ringstack/agent-mcp start
```

For Claude Desktop or any other MCP host, use the same command and environment in its `mcpServers` config. `-s` keeps pnpm quiet: stdout carries only the MCP protocol, and logs go to stderr.

## Check it

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json pnpm --filter @ringstack/agent-mcp smoke
```

This spawns the server through a real MCP client over stdio, against the [demo API](../paywall-demo). It lists the tools, reads the balance, makes a paid call, has a second call refused by the daily budget, and reads the ledger.

## Safety

The server holds the agent's **spending key**: anything that can call `paid_fetch` can spend up to the daily budget. Keep the wallet small, set `AGENT_ALLOW_HOSTS`, and keep the budget low.
