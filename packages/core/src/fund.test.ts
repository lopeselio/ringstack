import { describe, expect, it } from "vitest";

import { funderPath } from "./fund.ts";

describe("funderPath", () => {
  it("resolves a relative path against the directory pnpm was run from", () => {
    expect(funderPath({ ZOLANA_FUNDER_KEYPAIR: ".devnet/funder.json", INIT_CWD: "/repo" })).toBe("/repo/.devnet/funder.json");
  });
  it("keeps an absolute path and treats unset or blank as no funder", () => {
    expect(funderPath({ ZOLANA_FUNDER_KEYPAIR: "/keys/funder.json", INIT_CWD: "/repo" })).toBe("/keys/funder.json");
    expect(funderPath({})).toBeUndefined();
    expect(funderPath({ ZOLANA_FUNDER_KEYPAIR: "  " })).toBeUndefined();
  });
  it("falls back to the process directory outside pnpm", () => {
    expect(funderPath({ ZOLANA_FUNDER_KEYPAIR: "funder.json" })).toBe(`${process.cwd()}/funder.json`);
  });
});
