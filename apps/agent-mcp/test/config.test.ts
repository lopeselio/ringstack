import { describe, expect, it } from "vitest";

import { loadAgentConfig, sol } from "../src/config.ts";

describe("agent config", () => {
  it("parses limits in SOL and hosts", () => {
    const c = loadAgentConfig({
      AGENT_KEYPAIR: "/k.json",
      AGENT_MAX_PER_CALL: "0.002",
      AGENT_DAILY_BUDGET: "0.05",
      AGENT_ALLOW_HOSTS: "api.example.com, data.example.org",
      AGENT_LEDGER: "/tmp/l.json",
    });
    expect(c.policy).toEqual({ maxPerCall: 2_000_000n, dailyBudget: 50_000_000n, allowHosts: ["api.example.com", "data.example.org"] });
    expect(c.ledgerPath).toBe("/tmp/l.json");
  });

  it("defaults limits and rejects bad input", () => {
    const c = loadAgentConfig({ AGENT_KEYPAIR: "/k.json" });
    expect(c.policy).toEqual({ maxPerCall: 1_000_000n, dailyBudget: 10_000_000n });
    expect(() => loadAgentConfig({})).toThrow(/AGENT_KEYPAIR/);
    expect(() => loadAgentConfig({ AGENT_KEYPAIR: "/k", AGENT_DAILY_BUDGET: "lots" })).toThrow(/AGENT_DAILY_BUDGET/);
  });

  it("formats SOL", () => {
    expect([sol(500_000n), sol(1_000_000_000n), sol(0n)]).toEqual(["0.0005", "1", "0"]);
  });
});
