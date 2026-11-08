import { ShieldedKeypair, initializePoseidon } from "@heliuslabs/spr";
import { randomBlinding } from "@heliuslabs/spr/keypair";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, SOL_MINT, Utxo } from "@heliuslabs/spr/transaction";
import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import { decodeMemo, encodeMemo, readMemo, signTransferWithMemos, type MemoSource } from "./memo.ts";

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
