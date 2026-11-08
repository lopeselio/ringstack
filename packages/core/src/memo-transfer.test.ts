import { ShieldedKeypair, initializePoseidon, type ViewingKey } from "@heliuslabs/spr";
import { ProgramOwner, ShieldedPda } from "@heliuslabs/spr/program";
import { randomBlinding } from "@heliuslabs/spr/keypair";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, SOL_MINT, Utxo } from "@heliuslabs/spr/transaction";
import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import { decodeMemo, encodeMemo, readMemo, signTransferWithMemos, type MemoSource, type OutputMemo } from "./memo.ts";

beforeAll(async () => {
  await initializePoseidon();
});

const payer = address("11111111111111111111111111111112");

/** Sign a real transfer with one memo per recipient and read each memo back as its recipient. */
function roundTrip(recipients: number, { compact = false } = {}) {
  const sender = ShieldedKeypair.generate();
  const payees = Array.from({ length: recipients }, () => ShieldedKeypair.generate());
  const funds = new Utxo({ owner: sender.signingPublicKey(), asset: SOL_MINT, amount: 1_000_000n, blinding: randomBlinding() });
  const input = ProofInputUtxo.fromKeypair(funds, sender);
  const transfer = compact
    ? ConfidentialTransfer.compact(sender.shieldedAddress(), [input], payer)
    : new ConfidentialTransfer(sender.shieldedAddress(), [input], payer);
  payees.forEach((p) => transfer.send(p.shieldedAddress(), SOL_MINT, 1_000n));
  const memos = payees.map((p, i) => ({ recipient: p.shieldedAddress(), memo: encodeMemo(`memo ${i}`) }));
  const signed = signTransferWithMemos(transfer, sender, new AssetRegistry(), memos);

  const ext = signed.externalData;
  const tx: MemoSource = {
    outputSlots: ext.resolvedOwnerTags.map((viewTag) => ({ viewTag })),
    messages: ext.messages,
  };
  const read = payees.map((p, i) => {
    const key = p.viewingKey();
    const tag = p.shieldedAddress().confidentialViewTag();
    const position = ext.resolvedOwnerTags.findIndex((t) => t.every((b, j) => b === tag[j]));
    return decodeMemo(readMemo(tx, position, (data, ordinal) => key.decryptUtxo(data, ext.txViewingPublicKey, ext.salt, ordinal))) ?? `unreadable ${i}`;
  });
  return { slots: ext.outputs.length, read };
}

// Recipients plus the sender's change, and the slots that publishes: a transfer
// pads its real outputs up to 2, 4, 8 or 16, and every padded slot takes a
// ciphertext ordinal, so memos must start after all of them.
const cases = [
  { recipients: 1, slots: 2 },
  { recipients: 2, slots: 4 },
  { recipients: 3, slots: 4 },
  { recipients: 4, slots: 8 },
  { recipients: 7, slots: 8 },
  { recipients: 9, slots: 16 },
];

type Address = ReturnType<ShieldedKeypair["shieldedAddress"]>;

/**
 * Sign a transfer from a fresh sender that pays each of `to` 1,000 (paying
 * the sender itself when `to` is "self"), with `memos`, and read the memo of
 * every output carrying `reader`'s view tag, in slot order.
 */
function signAndRead(
  to: readonly (Address | "self")[],
  memos: (self: Address) => OutputMemo[],
  reader?: { address: Address; viewingKey: ViewingKey },
) {
  const sender = ShieldedKeypair.generate();
  const self = sender.shieldedAddress();
  const funds = new Utxo({ owner: sender.signingPublicKey(), asset: SOL_MINT, amount: 1_000_000n, blinding: randomBlinding() });
  const transfer = new ConfidentialTransfer(self, [ProofInputUtxo.fromKeypair(funds, sender)], payer);
  for (const r of to) transfer.send(r === "self" ? self : r, SOL_MINT, 1_000n);
  const signed = signTransferWithMemos(transfer, sender, new AssetRegistry(), memos(self));
  const { address, viewingKey } = reader ?? { address: self, viewingKey: sender.viewingKey() };
  const ext = signed.externalData;
  const tx: MemoSource = { outputSlots: ext.resolvedOwnerTags.map((viewTag) => ({ viewTag })), messages: ext.messages };
  const tag = address.confidentialViewTag();
  const positions = ext.resolvedOwnerTags.flatMap((t, i) => (t.every((b, j) => b === tag[j]) ? [i] : []));
  return positions.map((position) =>
    decodeMemo(readMemo(tx, position, (data, ordinal) => viewingKey.decryptUtxo(data, ext.txViewingPublicKey, ext.salt, ordinal))),
  );
}

describe("choosing a memo's output", () => {
  const payee = ShieldedKeypair.generate();
  const asPayee = () => ({ address: payee.shieldedAddress(), viewingKey: payee.viewingKey() });
  const memo = (text: string, nth?: number): OutputMemo => ({
    recipient: payee.shieldedAddress(),
    memo: encodeMemo(text),
    ...(nth === undefined ? {} : { nth }),
  });
  // Built lazily: addresses hash with Poseidon, which loads in beforeAll.
  const twice = () => [payee.shieldedAddress(), payee.shieldedAddress()];

  it("puts a memo on the named output when a recipient is paid twice", () => {
    // By order alone, the one memo would pair with the first output.
    expect(signAndRead(twice(), () => [memo("invoice 2", 1)], asPayee())).toEqual([undefined, "invoice 2"]);
  });

  it("gives memos without nth the outputs the named ones leave", () => {
    expect(signAndRead(twice(), () => [memo("free"), memo("named", 0)], asPayee())).toEqual(["named", "free"]);
  });

  it("refuses an nth past the recipient's outputs, or two memos for one output", () => {
    expect(() => signAndRead(twice(), () => [memo("x", 2)])).toThrow(RangeError);
    expect(() => signAndRead(twice(), () => [memo("a", 1), memo("b", 1)])).toThrow(RangeError);
    expect(() => signAndRead([payee.shieldedAddress()], () => [memo("a"), memo("b")])).toThrow(RangeError);
  });

  it("puts a memo for one's own address on the payment, not the change", () => {
    // Slot 0 is the sender's change, slot 1 the payment to itself.
    expect(signAndRead(["self"], (self) => [{ recipient: self, memo: encodeMemo("to me") }])).toEqual([undefined, "to me"]);
  });

  it("tells apart addresses that share a viewing key", () => {
    // A program address keeps its creator's viewing key but has its own signing identity.
    const creator = ShieldedKeypair.generate();
    const pda = ShieldedPda.withViewingKey(address("11111111111111111111111111111113"), ProgramOwner.nullifierKey(), creator.viewingKey());
    const pdaAddress = pda.shieldedAddress();
    const creatorAddress = creator.shieldedAddress();
    const read = signAndRead(
      [creatorAddress, pdaAddress],
      () => [{ recipient: pdaAddress, memo: encodeMemo("for the pda") }],
      { address: pdaAddress, viewingKey: creator.viewingKey() },
    );
    expect(read).toEqual(["for the pda"]);
    pda.destroy();
  });
});

describe("memos on signed transfers", () => {
  for (const { recipients, slots } of cases) {
    it(`every recipient reads its memo: ${recipients} recipient(s), ${slots} slots`, () => {
      const result = roundTrip(recipients);
      expect(result.slots).toBe(slots);
      expect(result.read).toEqual(Array.from({ length: recipients }, (_, i) => `memo ${i}`));
    });
  }

  it("counts only published slots under compact padding", () => {
    // 2 recipients and change: 3 real outputs, and compact padding publishes no 4th.
    const result = roundTrip(2, { compact: true });
    expect(result.slots).toBe(3);
    expect(result.read).toEqual(["memo 0", "memo 1"]);
  });
});
