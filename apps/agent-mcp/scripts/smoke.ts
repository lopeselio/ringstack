/**
 * The MCP server driven by a real MCP client over stdio, against the paid demo
 * API (devnet or localnet): list tools, balance, a paid call, the daily budget,
 * the ledger.
 *
 *   ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=… pnpm --filter @ringstack/agent-mcp smoke
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  RingSession,
  clientConfigFromEnv,
  exportKeyFile,
  fund,
  loadShieldedKeypair,
  networkFromEnv,
  parseKeyFile,
} from "@ringstack/core";

import { createDemoApp } from "../../paywall-demo/src/app.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());
const dir = mkdtempSync(join(tmpdir(), "agent-mcp-"));

// Vendor + demo API.
const vendor = await RingSession.open(client, ShieldedKeypair.generate());
await fund(client, vendor.owner, 20_000_000n);
await vendor.register();
const vk = parseKeyFile(exportKeyFile(vendor.keypair));
const app = createDemoApp({
  paywall: {
    client,
    vendor: { address: vk.address, viewingSecret: vk.viewingSecret },
    recipient: vendor.owner,
    cluster: networkFromEnv(),
    label: "Forecast API",
  },
  price: "0.0005",
});
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

// Agent wallet: a keypair file with a private balance.
const keypairPath = join(dir, "agent.json");
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  writeFileSync(keypairPath, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
}
const agent = await RingSession.open(client, await loadShieldedKeypair(keypairPath));
await fund(client, agent.owner, 40_000_000n);
await agent.deposit(20_000_000n);

// Spawn the MCP server the way an agent host would.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(import.meta.dirname, "../src/main.ts")],
  env: {
    ...(process.env as Record<string, string>),
    AGENT_KEYPAIR: keypairPath,
    AGENT_MAX_PER_CALL: "0.001",
    AGENT_DAILY_BUDGET: "0.0005", // exactly one call
    AGENT_ALLOW_HOSTS: new URL(base).host,
    AGENT_LEDGER: join(dir, "ledger.json"),
  },
  stderr: "ignore",
});
const mcp = new Client({ name: "smoke", version: "0.0.0" });
await mcp.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { ...JSON.parse(res.content[0]!.text), isError: res.isError === true };
};

const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
check(JSON.stringify(tools) === JSON.stringify(["paid_fetch", "spending", "wallet_balance"]), `tools ${tools}`);
console.log(`tools          ${tools.join(", ")}`);

const bal = await call("wallet_balance");
check(bal.privateBalanceSol === "0.02" && bal.address === agent.owner, `balance ${JSON.stringify(bal)}`);
console.log(`wallet_balance ${bal.privateBalanceSol} SOL private, budget ${bal.dailyBudgetSol}/day`);

const first = await call("paid_fetch", { url: `${base}/v1/forecast?city=Berlin` });
check(first.status === 200 && first.paid?.amountSol === "0.0005" && JSON.parse(first.body).city === "Berlin", `paid_fetch ${JSON.stringify(first)}`);
console.log(`paid_fetch     200, paid ${first.paid.amountSol} SOL (${first.paid.signature.slice(0, 10)}…)`);

const second = await call("paid_fetch", { url: `${base}/v1/alerts?city=Berlin` });
check(second.isError && second.refused === "OVER_DAILY_BUDGET", `second call ${JSON.stringify(second)}`);
console.log(`paid_fetch     refused: ${second.refused}`);

const ledger = await call("spending");
check(ledger.payments.length === 1 && ledger.today.spentSol === "0.0005", `spending ${JSON.stringify(ledger)}`);
console.log(`spending       ${ledger.payments.length} payment, ${ledger.today.spentSol} of ${ledger.today.budgetSol} SOL today`);

await mcp.close();
await app.close();
console.log("ok: MCP agent wallet paid an API privately and enforced its budget");
