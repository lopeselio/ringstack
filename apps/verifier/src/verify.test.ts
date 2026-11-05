import { describe, expect, it } from "vitest";

import { VerifyError, endpointsFor, verifyReceipt } from "./verify.ts";

describe("endpointsFor", () => {
  it("uses cluster defaults", () => {
    expect(endpointsFor("localnet", new URLSearchParams())).toEqual({
      rpcUrl: "http://127.0.0.1:8899",
      indexerUrl: "http://127.0.0.1:8784",
    });
    expect(endpointsFor("devnet", new URLSearchParams()).rpcUrl).toBe("https://api.devnet.solana.com");
  });

  it("applies ?rpc= and ?indexer= overrides", () => {
    const params = new URLSearchParams({ rpc: "https://rpc.example", indexer: "https://idx.example" });
    expect(endpointsFor("devnet", params)).toEqual({ rpcUrl: "https://rpc.example", indexerUrl: "https://idx.example" });
  });

  it("rejects mainnet receipts without overrides", () => {
    expect(() => endpointsFor("mainnet", new URLSearchParams())).toThrow(VerifyError);
  });
});

describe("verifyReceipt", () => {
  it("rejects malformed links before any network call", async () => {
    await expect(verifyReceipt("ringrcpt1:nope")).rejects.toThrow(/valid receipt link/);
    await expect(verifyReceipt("hello")).rejects.toThrow(VerifyError);
  });
});
