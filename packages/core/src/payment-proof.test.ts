import { ShieldedKeypair, ViewingKey, initializePoseidon } from "@heliuslabs/spr";
import { randomSalt } from "@heliuslabs/spr/keypair";
import { getBase58Decoder, type Signature } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PAYMENT_PROOF_PREFIX,
  applySlotCipher,
  decodePaymentProof,
  encodePaymentProof,
  type PaymentProof,
} from "./payment-proof.ts";

beforeAll(async () => {
  await initializePoseidon();
});

describe("slot cipher", () => {
  it("decrypts what the SDK encrypts, from either side's shared secret", () => {
    const ephemeral = ViewingKey.generate(); // the sender's per-transaction key
    const payee = ShieldedKeypair.generate();
    const payeeKey = payee.viewingKey();
    const recipientPk = payee.shieldedAddress().viewingPublicKey;
    const plaintext = crypto.getRandomValues(new Uint8Array(90));
    const salt = randomSalt();

    for (const slot of [0, 1, 7]) {
      const ct = ephemeral.encryptSlot(recipientPk, plaintext, salt, slot);
      const fromPayee = payeeKey.ecdh(ephemeral.publicKey());
      const fromSender = ephemeral.ecdh(recipientPk);
      expect(fromPayee).toEqual(fromSender);
      expect(applySlotCipher(fromPayee, ephemeral.publicKey(), recipientPk.toBytes(), ct, salt, slot)).toEqual(plaintext);
      expect(payeeKey.decryptUtxo(ct, ephemeral.publicKey(), salt, slot)).toEqual(plaintext);
      // The wrong slot index yields different bytes.
      expect(applySlotCipher(fromPayee, ephemeral.publicKey(), recipientPk.toBytes(), ct, salt, slot + 1)).not.toEqual(plaintext);
    }
  });
});

describe("proof encoding", () => {
  it("round-trips and rejects malformed input", () => {
    const proof: PaymentProof = {
      cluster: "devnet",
      signature: getBase58Decoder().decode(new Uint8Array(64).map((_, i) => i + 1)) as Signature,
      outputSlot: 3,
      sharedSecret: crypto.getRandomValues(new Uint8Array(32)),
      recipient: ShieldedKeypair.generate().shieldedAddress(),
    };
    const link = encodePaymentProof(proof);
    expect(link.startsWith(PAYMENT_PROOF_PREFIX)).toBe(true);
    const back = decodePaymentProof(link);
    expect(back.signature).toBe(proof.signature);
    expect(back.outputSlot).toBe(3);
    expect(back.sharedSecret).toEqual(proof.sharedSecret);
    expect(back.recipient.toBytes()).toEqual(proof.recipient.toBytes());
    expect(back.cluster).toBe("devnet");
    expect(() => decodePaymentProof("ringrcpt1:abc")).toThrow(/start with/);
    expect(() => decodePaymentProof(link.slice(0, -4))).toThrow(/bytes/);
  });
});
