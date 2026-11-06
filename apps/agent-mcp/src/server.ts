/**
 * MCP server that gives an agent a private wallet for paying APIs.
 *
 * Tools:
 *   wallet_balance   private SOL balance, address, and today's spend vs budget
 *   paid_fetch       HTTP request that pays RingPay 402 challenges within the policy
 *   spending         the spend ledger
 *
 * Payments are private transfers (amount and order id encrypted); the API
 * learns only its own payment. Spend limits are enforced here, before paying.
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RingSession } from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";
import { SpendLedger, SpendRefused, paidFetch, type SpendPolicy } from "@ringstack/paywall";
import { z } from "zod";

import { sol } from "./config.ts";

const MAX_BODY_CHARS = 20_000;

export interface AgentServerOptions {
  readonly session: RingSession;
  readonly cluster: Cluster;
  readonly policy: SpendPolicy;
  readonly ledger: SpendLedger;
  readonly fetch?: typeof fetch;
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createAgentServer(opts: AgentServerOptions): McpServer {
  const server = new McpServer({ name: "ringstack-agent", version: "0.0.0" });

  // One wallet operation at a time: concurrent calls would pick the same UTXOs.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const today = () => new Date().toISOString().slice(0, 10);

  server.registerTool(
    "wallet_balance",
    {
      title: "Private wallet balance",
      description: "The agent's private SOL balance, its address, and how much of today's budget is spent.",
    },
    () =>
      serial(async () => {
        await opts.session.sync();
        const spent = opts.ledger.spentOn(today());
        return text({
          address: opts.session.owner,
          cluster: opts.cluster,
          privateBalanceSol: sol(opts.session.wallet.balance(SOL_MINT).amount),
          spentTodaySol: sol(spent),
          dailyBudgetSol: sol(opts.policy.dailyBudget),
          maxPerCallSol: sol(opts.policy.maxPerCall),
          allowHosts: opts.policy.allowHosts ?? "any",
        });
      }),
  );

  server.registerTool(
    "paid_fetch",
    {
      title: "Fetch a URL, paying privately if asked",
      description:
        "Make an HTTP request. If the API answers 402 with a ringpay: request, pay it privately (within the per-call limit, daily budget and host allow-list) and retry. Returns the status, what was paid, and the response body.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        body: z.string().optional().describe("Request body, for POST/PUT/PATCH"),
        contentType: z.string().optional().describe("Content-Type of the body"),
      },
    },
    ({ url, method, body, contentType }) =>
      serial(async () => {
        await opts.session.sync();
        try {
          const { response, payment } = await paidFetch(
            url,
            {
              method,
              ...(body === undefined ? {} : { body }),
              ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
            },
            {
              session: opts.session,
              cluster: opts.cluster,
              policy: opts.policy,
              ledger: opts.ledger,
              ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
            },
          );
          const raw = await response.text();
          return text({
            status: response.status,
            paid: payment === undefined ? null : { amountSol: sol(BigInt(payment.amount)), signature: payment.signature },
            body: raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS)}… (truncated)` : raw,
          });
        } catch (e) {
          if (e instanceof SpendRefused) return text({ refused: e.code, reason: e.message, paid: null }, true);
          return text({ error: (e as Error).message }, true);
        }
      }),
  );

  server.registerTool(
    "spending",
    {
      title: "Spend ledger",
      description: "Payments this agent has made, with today's total against the daily budget.",
    },
    async () =>
      text({
        today: { spentSol: sol(opts.ledger.spentOn(today())), budgetSol: sol(opts.policy.dailyBudget) },
        payments: opts.ledger.records.map((r) => ({ ...r, amountSol: sol(BigInt(r.amount)) })),
      }),
  );

  return server;
}
