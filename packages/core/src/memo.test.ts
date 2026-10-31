import { describe, expect, it } from "vitest";

import { MEMO_LENGTH, decodeMemo, encodeMemo } from "./memo.ts";

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
