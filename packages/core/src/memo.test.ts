import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MEMO_LENGTH, decodeMemo, encodeMemo, memoMessageFor, readMemo } from "./memo.ts";

describe("memo encoding", () => {
  it("round-trips and pads to a fixed width", () => {
    const bytes = encodeMemo("order:42");
    expect(bytes.length).toBe(MEMO_LENGTH);
    expect(decodeMemo(bytes)).toBe("order:42");
  });

  it("round-trips multi-byte UTF-8", () => {
    expect(decodeMemo(encodeMemo("café ☕"))).toBe("café ☕");
  });

  it("treats absent and zero memos as none", () => {
    expect(decodeMemo(undefined)).toBeUndefined();
    expect(decodeMemo(new Uint8Array(MEMO_LENGTH))).toBeUndefined();
  });

  it("rejects oversize and NUL-containing memos", () => {
    expect(() => encodeMemo("x".repeat(MEMO_LENGTH + 1))).toThrow(RangeError);
    expect(() => encodeMemo("a\0b")).toThrow(RangeError);
  });
});

describe("memo messages", () => {
  const tag = (n: number) => new Uint8Array(32).fill(n);
  // Stream "cipher" keyed by the ordinal: like AES-CTR, a wrong ordinal
  // decrypts to random-looking bytes.
  const xor = (data: Uint8Array, ordinal: number) => {
    const stream = createHash("sha256").update(`ordinal ${ordinal}`).digest();
    return data.map((b, i) => b ^ stream[i]!);
  };
  const tx = {
    outputSlots: [{ viewTag: tag(1) }, { viewTag: tag(2) }, { viewTag: tag(1) }],
    messages: [
      { viewTag: tag(1), data: xor(encodeMemo("first"), 3) },
      { viewTag: tag(1), data: xor(encodeMemo("second"), 4) },
    ],
  };

  it("pairs the k-th output with a tag to the k-th message with it", () => {
    expect(memoMessageFor(tx, 0)?.ordinal).toBe(3);
    expect(memoMessageFor(tx, 2)?.ordinal).toBe(4);
    expect(memoMessageFor(tx, 1)).toBeUndefined();
    expect(memoMessageFor(tx, 9)).toBeUndefined();
  });

  it("decrypts at the message's ordinal (after every output slot)", () => {
    expect(decodeMemo(readMemo(tx, 0, xor))).toBe("first");
    expect(decodeMemo(readMemo(tx, 2, xor))).toBe("second");
    expect(readMemo(tx, 1, xor)).toBeUndefined();
  });

  it("reads memos sent before the ordinal fix, from padded transfers", () => {
    // 3 real outputs padded to 4 slots: the old writer started at 3, not 4.
    const slots = [tag(1), tag(2), tag(1), tag(9)].map((viewTag) => ({ viewTag }));
    const old = {
      outputSlots: slots,
      messages: [
        { viewTag: tag(1), data: xor(encodeMemo("early"), 3) },
        { viewTag: tag(1), data: xor(encodeMemo("late"), 4) },
      ],
    };
    expect(decodeMemo(readMemo(old, 0, xor))).toBe("early");
    expect(decodeMemo(readMemo(old, 2, xor))).toBe("late");
    // 1 real output padded to 2 slots: the old writer started at 1.
    const single = { outputSlots: [{ viewTag: tag(1) }, { viewTag: tag(9) }], messages: [{ viewTag: tag(1), data: xor(encodeMemo("one"), 1) }] };
    expect(decodeMemo(readMemo(single, 0, xor))).toBe("one");
  });

  it("accepts a legacy ordinal only for an exactly encoded memo", () => {
    const slots = [tag(1), tag(9), tag(9), tag(9)].map((viewTag) => ({ viewTag }));
    // Decodes as text at ordinal 3, but with junk after the first zero.
    const junk = encodeMemo("ok");
    junk[10] = 7;
    const tx = { outputSlots: slots, messages: [{ viewTag: tag(1), data: xor(junk, 3) }] };
    expect(readMemo(tx, 0, xor)).toBeUndefined();
  });

  it("ignores messages that are not well-formed memos", () => {
    const bad = { outputSlots: [{ viewTag: tag(1) }], messages: [{ viewTag: tag(1), data: new Uint8Array(7) }] };
    expect(readMemo(bad, 0, xor)).toBeUndefined();
    const throws = () => {
      throw new Error("no key");
    };
    expect(readMemo(tx, 0, throws)).toBeUndefined();
  });
});
