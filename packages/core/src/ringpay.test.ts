import { SOL_MINT } from "@heliuslabs/spr";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { decodeMemo } from "./memo.ts";
import {
  encodePaymentRequest,
  orderFromMemo,
  orderMemo,
  parsePaymentRequest,
  toBaseUnits,
  type RingPayError,
} from "./ringpay.ts";

const MERCHANT = address("GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD");
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as RingPayError).code;
  }
  return "no error";
}

describe("parsePaymentRequest", () => {
  it("parses the spec example", () => {
    const req = parsePaymentRequest(
      `ringpay:${MERCHANT}?amount=0.0125&order=1042&label=Corner%20Caf%C3%A9&message=Flat%20white&cluster=devnet`,
    );
    expect(req).toEqual({
      recipient: MERCHANT,
      amount: "0.0125",
      mint: SOL_MINT,
      order: "1042",
      label: "Corner Café",
      message: "Flat white",
      cluster: "devnet",
    });
  });

  it("applies defaults and ignores unknown parameters", () => {
    expect(parsePaymentRequest(`ringpay:${MERCHANT}`)).toEqual({ recipient: MERCHANT, mint: SOL_MINT, cluster: "mainnet" });
    expect(parsePaymentRequest(`RINGPAY:${MERCHANT}?future=1&mint=${USDC}`).mint).toBe(USDC);
  });

  it("keeps + literal rather than turning it into a space", () => {
    expect(parsePaymentRequest(`ringpay:${MERCHANT}?message=a+b`).message).toBe("a+b");
  });

  it("rejects malformed requests with specific codes", () => {
    expect(code(() => parsePaymentRequest(`solana:${MERCHANT}`))).toBe("NOT_RINGPAY");
    expect(code(() => parsePaymentRequest("ringpay:not-an-address"))).toBe("BAD_RECIPIENT");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?amount=1&amount=2`))).toBe("DUPLICATE_PARAM");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?req-tax=1`))).toBe("UNSUPPORTED_REQUIRED_PARAM");
    for (const a of ["-1", "1e3", ".5", "01", "1.", "0", "0.00", " 1"]) {
      expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?amount=${encodeURIComponent(a)}`))).toBe("BAD_AMOUNT");
    }
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?mint=nope`))).toBe("BAD_MINT");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?order=has%20space`))).toBe("BAD_ORDER");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?order=${"x".repeat(27)}`))).toBe("BAD_ORDER");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?label=${"x".repeat(65)}`))).toBe("BAD_LABEL");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?message=a%0Ab`))).toBe("BAD_MESSAGE");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?cluster=testnet`))).toBe("BAD_CLUSTER");
    expect(code(() => parsePaymentRequest(`ringpay:${MERCHANT}?label=%E0%A4%A`))).toBe("BAD_PARAM");
  });
});

describe("encodePaymentRequest", () => {
  it("round-trips and omits defaults", () => {
    const req = {
      recipient: MERCHANT,
      amount: "25",
      mint: USDC,
      order: "inv-2026-11-0007",
      label: "Corner Café & Co",
      message: "50% off? yes=1",
      cluster: "devnet" as const,
    };
    const uri = encodePaymentRequest(req);
    expect(parsePaymentRequest(uri)).toEqual(req);
    expect(encodePaymentRequest({ recipient: MERCHANT, mint: SOL_MINT, cluster: "mainnet" })).toBe(`ringpay:${MERCHANT}`);
  });

  it("refuses to encode invalid values", () => {
    expect(code(() => encodePaymentRequest({ recipient: MERCHANT, order: "no spaces" }))).toBe("BAD_ORDER");
    expect(code(() => encodePaymentRequest({ recipient: MERCHANT, amount: "1e9" }))).toBe("BAD_AMOUNT");
  });
});

describe("amounts and order memos", () => {
  it("converts UI amounts to base units", () => {
    expect(toBaseUnits("0.0125", 9)).toBe(12_500_000n);
    expect(toBaseUnits("25", 6)).toBe(25_000_000n);
    expect(toBaseUnits("1.5", 1)).toBe(15n);
    expect(code(() => toBaseUnits("0.0000001", 6))).toBe("BAD_AMOUNT");
  });

  it("puts the order in a fixed-width memo and reads it back", () => {
    const memo = orderMemo("1042");
    expect(memo.length).toBe(32);
    expect(decodeMemo(memo)).toBe("order:1042");
    expect(orderFromMemo(memo)).toBe("1042");
    expect(orderFromMemo("order:inv-2026-11-0007")).toBe("inv-2026-11-0007");
    expect(orderMemo("x".repeat(26)).length).toBe(32);
    expect(code(() => orderMemo("x".repeat(27)))).toBe("BAD_ORDER");
  });

  it("ignores memos that are not order references", () => {
    expect(orderFromMemo(undefined)).toBeUndefined();
    expect(orderFromMemo("thanks!")).toBeUndefined();
    expect(orderFromMemo("order:")).toBeUndefined();
    expect(orderFromMemo("order:bad id")).toBeUndefined();
  });
});
