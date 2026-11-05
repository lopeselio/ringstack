import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShieldedKeypair, SigningKey, initializePoseidon } from "@heliuslabs/zolana";
import { beforeAll, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.ts";
import { eventType, type RingdEvent } from "../src/events.ts";
import { exportKeyFile, parseKeyFile } from "@ringstack/core";
import { RingdStore } from "../src/store.ts";

beforeAll(async () => {
  await initializePoseidon();
});

describe("key file", () => {
  it("round-trips the read-only roles and omits the spending key", () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const seedHex = Buffer.from(seed).toString("hex");
    const seedB64 = Buffer.from(seed).toString("base64");
    const kp = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed.slice() as never));
    const text = exportKeyFile(kp);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["address", "nullifierKey", "version", "viewingKey"]);
    expect(text).not.toContain(seedHex);
    expect(text).not.toContain(seedB64);

    const parsed = parseKeyFile(text);
    expect(parsed.address.toBytes()).toEqual(kp.shieldedAddress().toBytes());
    expect(parsed.keys.address().toBytes()).toEqual(kp.shieldedAddress().toBytes());
  });

  it("rejects keys that do not match the address", () => {
    const a = JSON.parse(exportKeyFile(ShieldedKeypair.generate()));
    const b = JSON.parse(exportKeyFile(ShieldedKeypair.generate()));
    expect(() => parseKeyFile(JSON.stringify({ ...a, viewingKey: b.viewingKey }))).toThrow(/viewingKey/);
    expect(() => parseKeyFile(JSON.stringify({ ...a, nullifierKey: b.nullifierKey }))).toThrow(/nullifierKey/);
    expect(() => parseKeyFile(JSON.stringify({ ...a, version: 2 }))).toThrow(/version/);
  });
});

describe("config", () => {
  const toml = `
network = "localnet"
poll_interval_secs = 2

[[wallet]]
name = "shop"
key_file = "keys/shop.json"
`;

  it("parses wallets and resolves paths against the config dir", () => {
    const c = parseConfig(toml, "/srv/ringd", {});
    expect(c.network).toBe("localnet");
    expect(c.pollIntervalMs).toBe(2000);
    expect(c.database).toBe("/srv/ringd/ringd.db");
    expect(c.wallets).toEqual([{ name: "shop", keyFile: "/srv/ringd/keys/shop.json" }]);
  });

  it("rejects bad configs", () => {
    expect(() => parseConfig(`network = "mainnet"\n[[wallet]]\nname="a"\nkey_file="k"`, "/", {})).toThrow(/network/);
    expect(() => parseConfig(`network = "localnet"`, "/", {})).toThrow(/wallet/);
    expect(() => parseConfig(`[[wallet]]\nname="Bad Name"\nkey_file="k"`, "/", {})).toThrow(/name/);
    expect(() => parseConfig(`[[wallet]]\nname="a"\nkey_file="k"\n[[wallet]]\nname="a"\nkey_file="j"`, "/", {})).toThrow(
      /unique/,
    );
  });
});

describe("merge config", () => {
  it("parses per-wallet thresholds and the fee payer", () => {
    const c = parseConfig(
      `[[wallet]]\nname = "shop"\nkey_file = "k"\nmerge_threshold = 30\n[merge]\nfee_payer = "fee.json"\nmax_inputs = 12\n`,
      "/srv",
      {},
    );
    expect(c.wallets[0]).toEqual({ name: "shop", keyFile: "/srv/k", mergeThreshold: 30 });
    expect(c.merge).toEqual({ feePayer: "/srv/fee.json", maxInputs: 12 });
  });

  it("requires a fee payer when any wallet merges, and bounds the numbers", () => {
    const w = (extra: string) => `[[wallet]]\nname = "shop"\nkey_file = "k"\n${extra}`;
    expect(() => parseConfig(w("merge_threshold = 30\n"), "/", {})).toThrow(/fee_payer is required/);
    expect(() => parseConfig(w("merge_threshold = 1\n"), "/", {})).toThrow(/merge_threshold/);
    expect(() => parseConfig(w(`[merge]\nfee_payer = "f"\nmax_inputs = 25\n`), "/", {})).toThrow(/max_inputs/);
    expect(parseConfig(w(""), "/", {}).merge).toBeUndefined();
  });
});

describe("events", () => {
  it("maps history rows to event types", () => {
    expect(eventType({ kind: "privateTransfer", direction: "inbound" })).toBe("payment.received");
    expect(eventType({ kind: "deposit", direction: "inbound" })).toBe("payment.received");
    expect(eventType({ kind: "privateTransfer", direction: "outbound" })).toBe("payment.sent");
    expect(eventType({ kind: "merge", direction: "selfTransfer" })).toBe("utxo.merged");
    expect(eventType({ kind: "split", direction: "selfTransfer" })).toBe("wallet.activity");
  });
});

describe("store", () => {
  const event = (id: string, wallet = "shop"): RingdEvent => ({
    id,
    type: "payment.received",
    wallet,
    signature: "sig",
    slot: "1",
    kind: "privateTransfer",
    direction: "inbound",
    asset: "11111111111111111111111111111111",
    amount: "5",
    backfill: false,
    createdAt: new Date(0).toISOString(),
  });

  it("appends each (wallet, id) once and lists in order", () => {
    const store = new RingdStore(join(mkdtempSync(join(tmpdir(), "ringd-")), "t.db"));
    expect(store.appendEvents([event("a:1"), event("a:2")]).map((e) => e.event.id)).toEqual(["a:1", "a:2"]);
    expect(store.appendEvents([event("a:2"), event("a:3")]).map((e) => e.event.id)).toEqual(["a:3"]);
    expect(store.appendEvents([event("a:1", "other")])).toHaveLength(1);
    expect(store.listEvents({ wallet: "shop" }).map((e) => e.event.id)).toEqual(["a:1", "a:2", "a:3"]);
    expect(store.listEvents({ afterSeq: 2 }).map((e) => e.event.id)).toEqual(["a:3", "a:1"]);
    expect([...store.knownEventIds("shop")].sort()).toEqual(["a:1", "a:2", "a:3"]);
    store.close();
  });

  it("stores one snapshot per wallet, replacing on save", async () => {
    const store = new RingdStore(":memory:");
    const s = store.snapshotStore("shop");
    expect(await s.load()).toBeUndefined();
    await s.save("one");
    await s.save("two");
    expect(await s.load()).toBe("two");
    expect(await store.snapshotStore("other").load()).toBeUndefined();
    store.close();
  });
});
