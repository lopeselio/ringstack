#!/usr/bin/env -S npx tsx
/**
 * leakscan: measure how linkable public shielded-pool activity is.
 *
 *   leakscan scan   [--events events.json] [--days 14]   fetch new deposits/withdrawals
 *   leakscan stats  [--events events.json] [--out stats.json] [--window-hours 168]
 *   leakscan advise --amount <SOL> --recipient <addr> --mine <addr,...> [--events events.json]
 *
 * `scan` keeps a local event cache (addresses included, never published);
 * `stats` writes aggregate numbers only. Needs ZOLANA_NETWORK=devnet + API_KEY
 * (or ZOLANA_RPC_URL) for `scan`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/zolana";
import { getSolInterfaceAddress } from "@heliuslabs/zolana/addresses";
import { clientConfigFromEnv, networkFromEnv, toBaseUnits } from "@ringstack/core";

import { adviseWithdrawal } from "./advisor.ts";
import { analyze } from "./analyze.ts";
import type { PoolEvent } from "./events.ts";
import { httpRpc, mergeEvents, scan } from "./scan.ts";

interface Cache {
  network: string;
  newest?: string | undefined;
  events: PoolEvent[];
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    events: { type: "string", default: "leakscan-events.json" },
    out: { type: "string", default: "leakscan-stats.json" },
    days: { type: "string", default: "14" },
    "window-hours": { type: "string", default: "168" },
    max: { type: "string" },
    amount: { type: "string" },
    recipient: { type: "string" },
    mine: { type: "string", default: "" },
  },
});

function load(path: string): Cache {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Cache) : { network: networkFromEnv(), events: [] };
}

function save(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 1));
  renameSync(`${path}.tmp`, path);
}

switch (command) {
  case "scan": {
    const cache = load(values.events);
    const network = networkFromEnv();
    if (cache.network !== network) throw new Error(`${values.events} holds ${cache.network} events, not ${network}`);
    const sinceTime = Math.floor(Date.now() / 1000) - Number(values.days) * 86400;
    const result = await scan(httpRpc(String(clientConfigFromEnv().solanaRpcUrl)), {
      program: SHIELDED_POOL_PROGRAM_ID,
      vault: String(await getSolInterfaceAddress()),
      sinceTime,
      ...(cache.newest === undefined ? {} : { until: cache.newest }),
      ...(values.max === undefined ? {} : { maxSignatures: Number(values.max) }),
      onProgress: (done, events) => console.error(`  ${done} transactions, ${events} public events`),
    });
    const events = mergeEvents(cache.events, result.events).filter((e) => e.time >= sinceTime);
    save(values.events, { network, newest: result.newest ?? cache.newest, events } satisfies Cache);
    console.error(`examined ${result.examined} transactions: ${result.events.length} new events, ${events.length} cached`);
    break;
  }
  case "stats": {
    const cache = load(values.events);
    const stats = analyze(cache.events, { network: cache.network, windowSecs: Number(values["window-hours"]) * 3600 });
    save(values.out, stats);
    const w = stats.withdrawals;
    const pct = (n: number) => (stats.totals.withdrawals ? `${((100 * n) / stats.totals.withdrawals).toFixed(0)}%` : "–");
    console.log(`${stats.network} ${stats.from?.slice(0, 10)} → ${stats.to?.slice(0, 10)}`);
    console.log(`  ${stats.totals.deposits} deposits, ${stats.totals.withdrawals} withdrawals`);
    console.log(`  linkable withdrawals: ${w.linkable} (${pct(w.linkable)})`);
    console.log(`    unique amount match ${w.uniqueAmountMatch} (${pct(w.uniqueAmountMatch)}), round trip ${w.roundTrip} (${pct(w.roundTrip)}), recipient reuse ${w.recipientReuse} (${pct(w.recipientReuse)})`);
    console.log(`  median naive anonymity set: ${stats.medianNaiveSet}`);
    console.error(`wrote ${values.out}`);
    break;
  }
  case "advise": {
    if (!values.amount || !values.recipient) throw new Error("advise needs --amount and --recipient");
    const advice = adviseWithdrawal(load(values.events).events, {
      amount: toBaseUnits(values.amount, 9),
      recipient: values.recipient,
      myDepositAddresses: values.mine.split(",").filter(Boolean),
    });
    console.log(`risk: ${advice.risk}`);
    for (const w of advice.warnings) console.log(`  ! ${w.message}`);
    for (const s of advice.suggestions) console.log(`  - ${s}`);
    process.exitCode = advice.risk === "high" ? 1 : 0;
    break;
  }
  default:
    console.error("usage: leakscan scan | stats | advise   (see src/cli.ts)");
    process.exitCode = 2;
}
