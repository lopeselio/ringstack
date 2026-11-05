import { homedir } from "node:os";
import { join } from "node:path";

import { toBaseUnits } from "@ringstack/core";
import type { SpendPolicy } from "@ringstack/paywall";

/**
 * Environment:
 *   AGENT_KEYPAIR        Solana keypair file of the agent's wallet (required)
 *   ZOLANA_NETWORK       devnet (API_KEY in the root .env) or localnet
 *   AGENT_MAX_PER_CALL   SOL per paid call (default 0.001)
 *   AGENT_DAILY_BUDGET   SOL per UTC day (default 0.01)
 *   AGENT_ALLOW_HOSTS    comma-separated hosts the agent may pay; unset = any
 *   AGENT_LEDGER         spend ledger file (default ~/.ringstack/agent-ledger.json)
 */
export interface AgentConfig {
  readonly keypair: string;
  readonly policy: SpendPolicy;
  readonly ledgerPath: string;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const keypair = env["AGENT_KEYPAIR"]?.trim();
  if (!keypair) throw new Error("AGENT_KEYPAIR must point at the agent's Solana keypair file");
  const sol = (name: string, fallback: string) => {
    const v = env[name]?.trim() || fallback;
    try {
      return toBaseUnits(v, 9);
    } catch {
      throw new Error(`${name} must be a SOL amount like 0.001, got ${JSON.stringify(v)}`);
    }
  };
  const hosts = env["AGENT_ALLOW_HOSTS"]
    ?.split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  return {
    keypair,
    policy: {
      maxPerCall: sol("AGENT_MAX_PER_CALL", "0.001"),
      dailyBudget: sol("AGENT_DAILY_BUDGET", "0.01"),
      ...(hosts !== undefined && hosts.length > 0 ? { allowHosts: hosts } : {}),
    },
    ledgerPath: env["AGENT_LEDGER"]?.trim() || join(homedir(), ".ringstack", "agent-ledger.json"),
  };
}

export function sol(base: bigint): string {
  const s = base.toString().padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "");
}
