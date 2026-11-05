#!/usr/bin/env -S node --import tsx
/**
 * ringd: self-hosted watcher for private payments.
 *
 *   ringd keys export --keypair <solana-keypair.json> --out <key-file>
 *   ringd run    [--config ringd.toml] [--once]
 *   ringd events [--config ringd.toml] [--wallet <name>] [--after <seq>] [--limit <n>]
 *   ringd deliveries [--config ringd.toml] [--webhook <name>] [--status pending|delivered|failed]
 *   ringd deliveries retry --webhook <name> [--config ringd.toml]
 */
import { parseArgs } from "node:util";

import { initializePoseidon } from "@heliuslabs/zolana";
import { loadShieldedKeypair } from "@ringstack/core";

import { loadConfig } from "./config.ts";
import { Daemon, jsonLogger } from "./daemon.ts";
import { writeKeyFile } from "./keyfile.ts";
import { RingdStore } from "./store.ts";

const USAGE = `usage:
  ringd keys export --keypair <solana-keypair.json> --out <key-file>
  ringd run    [--config ringd.toml] [--once]
  ringd events [--config ringd.toml] [--wallet <name>] [--after <seq>] [--limit <n>]
  ringd deliveries [--config ringd.toml] [--webhook <name>] [--status pending|delivered|failed]
  ringd deliveries retry --webhook <name> [--config ringd.toml]`;

async function keysExport(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { keypair: { type: "string" }, out: { type: "string" } },
  });
  if (!values.keypair || !values.out) throw new Error(USAGE);
  await initializePoseidon();
  const keypair = await loadShieldedKeypair(values.keypair);
  await writeKeyFile(values.out, keypair);
  console.log(`wrote ${values.out} (viewing + nullifier keys only; no spending key)`);
  console.log(`owner ${keypair.toSolanaSigner().address}`);
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string", default: "ringd.toml" }, once: { type: "boolean", default: false } },
  });
  const config = await loadConfig(values.config);
  const store = new RingdStore(config.database);
  const daemon = new Daemon({
    client: config.client,
    wallets: config.wallets,
    store,
    pollIntervalMs: config.pollIntervalMs,
    log: jsonLogger,
    webhooks: config.webhooks,
    delivery: config.delivery,
  });
  await daemon.start();
  if (values.once) {
    await daemon.runOnce();
    store.close();
    return;
  }
  const stop = () => {
    jsonLogger.info("stopping");
    daemon.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  jsonLogger.info("started", {
    network: config.network,
    wallets: config.wallets.length,
    webhooks: config.webhooks.length,
    pollMs: config.pollIntervalMs,
  });
  await daemon.run();
  store.close();
}

async function events(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", default: "ringd.toml" },
      wallet: { type: "string" },
      after: { type: "string", default: "0" },
      limit: { type: "string", default: "1000" },
    },
  });
  const config = await loadConfig(values.config);
  const store = new RingdStore(config.database);
  try {
    const rows = store.listEvents({
      ...(values.wallet === undefined ? {} : { wallet: values.wallet }),
      afterSeq: Number(values.after),
      limit: Number(values.limit),
    });
    for (const r of rows) console.log(JSON.stringify({ seq: r.seq, ...r.event }));
  } finally {
    store.close();
  }
}

async function deliveries(args: string[]) {
  const retry = args[0] === "retry";
  const { values } = parseArgs({
    args: retry ? args.slice(1) : args,
    options: {
      config: { type: "string", default: "ringd.toml" },
      webhook: { type: "string" },
      status: { type: "string" },
    },
  });
  const status = values.status;
  if (status !== undefined && status !== "pending" && status !== "delivered" && status !== "failed") {
    throw new Error("--status must be pending, delivered or failed");
  }
  const config = await loadConfig(values.config);
  const store = new RingdStore(config.database);
  try {
    if (retry) {
      if (values.webhook === undefined) throw new Error("deliveries retry needs --webhook");
      console.log(`requeued ${store.retryFailed(values.webhook)} failed deliveries for ${values.webhook}`);
      return;
    }
    for (const d of store.listDeliveries({
      ...(values.webhook === undefined ? {} : { webhook: values.webhook }),
      ...(status === undefined ? {} : { status }),
    })) {
      const { event, ...rest } = d;
      console.log(JSON.stringify({ ...rest, id: `${event.wallet}:${event.id}`, type: event.type }));
    }
  } finally {
    store.close();
  }
}

const [cmd, sub, ...rest] = process.argv.slice(2);
try {
  if (cmd === "keys" && sub === "export") await keysExport(rest);
  else if (cmd === "run") await run([sub, ...rest].filter((a): a is string => a !== undefined));
  else if (cmd === "events") await events([sub, ...rest].filter((a): a is string => a !== undefined));
  else if (cmd === "deliveries") await deliveries([sub, ...rest].filter((a): a is string => a !== undefined));
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
