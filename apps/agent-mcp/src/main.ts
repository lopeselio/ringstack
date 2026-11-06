#!/usr/bin/env -S node --import tsx
/**
 * ringstack agent wallet as an MCP server over stdio. See config.ts for the
 * environment. Logs go to stderr; stdout carries the MCP protocol.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RingSession, clientConfigFromEnv, loadShieldedKeypair, networkFromEnv } from "@ringstack/core";
import { SpendLedger } from "@ringstack/paywall";

import { loadAgentConfig } from "./config.ts";
import { createAgentServer } from "./server.ts";

// Keep stdout for the protocol: route stray console output to stderr.
console.log = (...args: unknown[]) => console.error(...args);

const config = loadAgentConfig();
mkdirSync(dirname(config.ledgerPath), { recursive: true, mode: 0o700 });

await initializePoseidon();
const client = await createSprClient(clientConfigFromEnv());
const session = await RingSession.open(client, await loadShieldedKeypair(config.keypair));

const server = createAgentServer({
  session,
  cluster: networkFromEnv(),
  policy: config.policy,
  ledger: new SpendLedger(config.ledgerPath),
});
await server.connect(new StdioServerTransport());
console.error(`ringstack agent wallet ready: ${session.owner} on ${networkFromEnv()}`);
