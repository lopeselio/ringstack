import { describe, expect, it } from "vitest";
import { getBase58Decoder, type Signature } from "@solana/kit";

import { RECEIPT_PREFIX, decodeReceipt, encodeReceipt, type Receipt } from "./receipt.ts";

const sig = getBase58Decoder().decode(new Uint8Array(64).map((_, i) => i + 1)) as Signature;
const key = new Uint8Array(32).map((_, i) => 255 - i);

describe("receipt codec", () => {
  it("round-trips with slot", () => {
    const r: Receipt = { cluster: "devnet", signature: sig, txViewingKey: key, slot: 123_456_789n };
    const enc = encodeReceipt(r);
    expect(enc.startsWith(RECEIPT_PREFIX)).toBe(true);
    expect(decodeReceipt(enc)).toEqual(r);
  });

  it("round-trips without slot", () => {
    const r: Receipt = { cluster: "localnet", signature: sig, txViewingKey: key };
    expect(decodeReceipt(encodeReceipt(r))).toEqual(r);
  });

  it("is URL-fragment safe", () => {
    const enc = encodeReceipt({ cluster: "mainnet", signature: sig, txViewingKey: key });
    expect(enc.slice(RECEIPT_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a wrong-length key", () => {
    expect(() => encodeReceipt({ cluster: "devnet", signature: sig, txViewingKey: new Uint8Array(31) })).toThrow(
      /32 bytes/,
    );
  });

  it("rejects bad prefix, version, and length", () => {
    const enc = encodeReceipt({ cluster: "devnet", signature: sig, txViewingKey: key });
    expect(() => decodeReceipt(enc.replace("ringrcpt1:", "x:"))).toThrow(/start with/);
    const body = Buffer.from(enc.slice(RECEIPT_PREFIX.length), "base64url");
    body[0] = 9;
    expect(() => decodeReceipt(RECEIPT_PREFIX + body.toString("base64url"))).toThrow(/version/);
    expect(() => decodeReceipt(RECEIPT_PREFIX + body.subarray(1).toString("base64url"))).toThrow(/bytes/);
  });

  it("encodes the body as unpadded base64url, matching Node", () => {
    for (let n = 0; n < 4; n++) {
      const r: Receipt = { cluster: "mainnet", signature: sig, txViewingKey: key.map((b) => b ^ n), slot: BigInt(n + 1) };
      const enc = encodeReceipt(r);
      const body = enc.slice(RECEIPT_PREFIX.length);
      expect(body).not.toMatch(/[+/=]/);
      expect(Buffer.from(body, "base64url").toString("base64url")).toBe(body);
      expect(decodeReceipt(enc)).toEqual(r);
    }
  });

  it("rejects non-base64url characters", () => {
    const enc = encodeReceipt({ cluster: "devnet", signature: sig, txViewingKey: key });
    expect(() => decodeReceipt(enc.slice(0, -2) + "+/")).toThrow(/base64url/);
  });
});
