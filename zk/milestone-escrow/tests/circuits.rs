//! The escrow's circuits through the harness, and its proofs through the
//! generated verifier modules exactly as the program calls them.

use std::path::Path;

use milestone_escrow::{
    circuits::{
        create::rule as create_rule, escrow_authority, refund::rule as refund_rule,
        release::rule as release_rule, Create, CreatePrivateInputs, CreatePublicInputs,
        EscrowTerms, Refund, RefundPrivateInputs, RefundPublicInputs, Release,
        ReleasePrivateInputs, ReleasePublicInputs,
    },
    instructions::{create::slot as create_slot, release::slot as release_slot},
    verifier::{create, refund, release},
    APPROVERS,
};
use ringstack_zk_gadgets::{
    harness::{assert_accepts, assert_no_free_variables, assert_refuses},
    threshold::{BELOW_THRESHOLD, DUPLICATE_SIGNER, SIGNER_NOT_APPROVER},
};
use spr_hasher::primitives::solana_owner_identity;
use spr_keypair::{ShieldedAddress, ShieldedKeypair};
use spr_program::{
    verifier::VerifyError, CompressedProof, Groth16Keys, Groth16Prover, SolanaProof, TxContext,
    ZkProgramCircuit,
};
use spr_transaction::WalletUtxo;

#[allow(dead_code)]
mod shared;
use shared::{keypair, token_input, TREE_ID};

const DEADLINE: u64 = 1_800_000_000;
const AMOUNT: u64 = 900;
const TRANCHE: u64 = 300;
const NONE: [u8; 32] = [0; 32];

fn prover<P: ZkProgramCircuit>(name: &str) -> Groth16Prover<P> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("keys");
    let digest = std::fs::read_to_string(dir.join(format!("{name}.pk.sha256"))).expect("digest");
    let hex = digest.split_whitespace().next().expect("hex");
    let checksum: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes");
    Groth16Prover::new(
        Groth16Keys::load_checked(&dir.join(format!("{name}.pk")), &checksum).expect("key"),
    )
    .expect("prover")
}

fn compressed(proof: &SolanaProof) -> CompressedProof {
    CompressedProof::try_from(proof).expect("compressed")
}

struct Party {
    keypair: ShieldedKeypair,
    address: ShieldedAddress,
    payer: pinocchio::Address,
    identity: [u8; 32],
}

fn party(seed: u8) -> Party {
    let keypair = keypair(seed);
    let address = keypair.shielded_address().expect("address");
    let payer = address.solana_address().expect("solana address");
    let identity = solana_owner_identity(payer.as_array()).expect("identity");
    Party {
        keypair,
        address,
        payer,
        identity,
    }
}

struct World {
    funder: Party,
    payee: Party,
    approvers: [Party; APPROVERS],
}

fn world() -> World {
    World {
        funder: party(5),
        payee: party(6),
        approvers: [party(7), party(8), party(9)],
    }
}

impl World {
    fn approver_ids(&self) -> [[u8; 32]; APPROVERS] {
        core::array::from_fn(|i| self.approvers[i].identity)
    }

    fn create(
        &self,
        amount: u64,
        tranche: u64,
        threshold: u16,
        approvers: [[u8; 32]; APPROVERS],
    ) -> Create {
        let authority = escrow_authority(&self.funder.payer);
        Create {
            private: CreatePrivateInputs {
                tx_context: TxContext::new(),
                token_utxos_asset_a: vec![
                    token_input(&self.funder.keypair, 600, 0),
                    token_input(&self.funder.keypair, 600, 1),
                ],
                amount,
                payee: self.payee.address.address_hash().expect("payee hash"),
                approvers,
                threshold,
                tranche,
            },
            public: CreatePublicInputs {
                escrow_owner: authority
                    .address(self.funder.keypair.viewing_pubkey())
                    .expect("owner"),
                funder_identity: self.funder.identity,
                deadline: DEADLINE,
            },
        }
    }

    fn valid_create(&self) -> Create {
        self.create(AMOUNT, TRANCHE, 2, self.approver_ids())
    }

    /// The escrow a transaction left in `slot`, as a spendable input.
    fn escrow_from(
        &self,
        spp: &spr_transaction::instructions::transact::SppProofInputs,
        slot: usize,
    ) -> (WalletUtxo, EscrowTerms) {
        let output = spp.output_utxos.get(slot).expect("escrow output");
        let mut escrow = escrow_authority(&self.funder.payer)
            .input(output, spp.output_tree_id, 2)
            .expect("escrow input");
        escrow.latest_tree_id = Some(TREE_ID);
        let terms: EscrowTerms =
            borsh::from_slice(output.data.utxo_data().expect("data")).expect("terms");
        (escrow, terms)
    }

    fn created_escrow(&self) -> (WalletUtxo, EscrowTerms, u64) {
        let spp = self
            .valid_create()
            .create_proof_inputs_and_encrypt_with_keys(
                &self.funder.keypair,
                self.funder.payer,
                u64::MAX,
            )
            .expect("create proof inputs");
        let (escrow, terms) = self.escrow_from(&spp, create_slot::ESCROW);
        (escrow, terms, AMOUNT)
    }

    fn release(
        &self,
        escrow: WalletUtxo,
        terms: EscrowTerms,
        signers: [[u8; 32]; APPROVERS],
    ) -> Release {
        Release {
            private: ReleasePrivateInputs {
                tx_context: TxContext::new(),
                escrow,
                terms,
                payee: self.payee.address,
                escrow_owner: self.escrow_address(),
            },
            public: ReleasePublicInputs {
                deadline: DEADLINE,
                funder_identity: self.funder.identity,
                signers,
            },
        }
    }

    /// Where the funder's escrows live: their authority PDA, their viewing key.
    fn escrow_address(&self) -> ShieldedAddress {
        escrow_authority(&self.funder.payer)
            .address(self.funder.keypair.viewing_pubkey())
            .expect("escrow address")
    }

    fn two_signers(&self) -> [[u8; 32]; APPROVERS] {
        [self.approvers[0].identity, self.approvers[2].identity, NONE]
    }
}

#[test]
fn create_accepts_valid_terms_and_refuses_each_bad_one() {
    let w = world();
    assert_eq!(assert_accepts(&w.valid_create()), 16_279);
    let ids = w.approver_ids();
    assert_refuses(&w.create(0, TRANCHE, 2, ids), create_rule::NOTHING_ESCROWED);
    assert_refuses(&w.create(AMOUNT, 0, 2, ids), create_rule::ZERO_TRANCHE);
    assert_refuses(
        &w.create(AMOUNT, AMOUNT + 1, 2, ids),
        create_rule::TRANCHE_TOO_LARGE,
    );
    assert_refuses(
        &w.create(AMOUNT, TRANCHE, 0, ids),
        create_rule::ZERO_THRESHOLD,
    );
    assert_refuses(
        &w.create(AMOUNT, TRANCHE, 2, [ids[0], ids[0], ids[1]]),
        create_rule::DUPLICATE_APPROVER,
    );
    // Two listed approvers cannot meet a threshold of three.
    assert_refuses(
        &w.create(AMOUNT, TRANCHE, 3, [ids[0], NONE, ids[1]]),
        create_rule::UNREACHABLE_THRESHOLD,
    );
    let mut stranger = w.valid_create();
    stranger.public.funder_identity = w.payee.identity;
    assert_refuses(&stranger, create_rule::NOT_FUNDERS_TOKENS);
}

#[test]
fn create_proves_and_the_program_verifier_accepts_it() {
    let w = world();
    let inputs = w.valid_create();
    let spp = inputs
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("create proof inputs");
    let proof = compressed(
        &prover::<Create>("create")
            .prove(&inputs)
            .expect("proof")
            .proof,
    );
    let hash = spp.padding_independent_private_tx_hash().expect("hash");
    create::Verifier {
        proof: &proof,
        public_inputs: create::PublicInputs {
            escrow_owner: inputs
                .public
                .escrow_owner
                .address_hash()
                .expect("owner hash"),
            funder_identity: w.funder.identity,
            deadline: DEADLINE,
        },
        private_tx_hash: &hash,
        transfers: &[],
    }
    .verify()
    .expect("create verifies");
    let (_, terms) = w.escrow_from(&spp, create_slot::ESCROW);
    assert_eq!(
        (terms.tranche, terms.threshold, terms.deadline),
        (TRANCHE, 2, DEADLINE)
    );
    assert_eq!(terms.approvers, w.approver_ids());
    assert_eq!(
        terms.escrow_address,
        w.escrow_address().address_hash().expect("hash")
    );
}

#[test]
fn release_pays_a_tranche_and_keeps_the_rest_under_the_same_terms() {
    let w = world();
    let (escrow, terms, _) = w.created_escrow();
    let inputs = w.release(escrow, terms.clone(), w.two_signers());
    assert_eq!(assert_accepts(&inputs), 11_813);

    let spp = inputs
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("release proof inputs");
    let payout = spp.output_utxos.get(release_slot::PAYOUT).expect("payout");
    assert_eq!(payout.amount, TRANCHE);
    let (rest, rest_terms) = w.escrow_from(&spp, release_slot::ESCROW);
    assert_eq!(rest.utxo.amount, AMOUNT - TRANCHE);
    assert_eq!(rest_terms, terms, "the remainder keeps the terms");

    let proof = compressed(
        &prover::<Release>("release")
            .prove(&inputs)
            .expect("proof")
            .proof,
    );
    let hash = spp.padding_independent_private_tx_hash().expect("hash");
    let mut verifier = release::Verifier {
        proof: &proof,
        public_inputs: release::PublicInputs {
            deadline: DEADLINE,
            funder_identity: w.funder.identity,
            signers: w.two_signers(),
        },
        private_tx_hash: &hash,
        transfers: &[],
    };
    verifier.verify().expect("release verifies");

    // What the program saw sign must be what the proof claims, slot by slot.
    let [a, b, _] = w.two_signers();
    for seen in [
        [a, NONE, NONE],
        [b, a, NONE],
        [a, b, w.approvers[1].identity],
    ] {
        verifier.public_inputs.signers = seen;
        assert_eq!(verifier.verify(), Err(VerifyError::Proof), "{seen:?}");
    }
    verifier.public_inputs.signers = w.two_signers();
    verifier.public_inputs.deadline = DEADLINE + 1;
    assert_eq!(verifier.verify(), Err(VerifyError::Proof));
}

#[test]
fn release_refuses_each_broken_rule() {
    let w = world();
    let (escrow, terms, _) = w.created_escrow();
    let ids = w.approver_ids();
    let release = |signers| w.release(escrow.clone(), terms.clone(), signers);

    assert_refuses(&release([ids[0], NONE, NONE]), BELOW_THRESHOLD);
    assert_refuses(&release([ids[1], ids[1], NONE]), DUPLICATE_SIGNER);
    assert_refuses(
        &release([ids[0], w.payee.identity, NONE]),
        SIGNER_NOT_APPROVER,
    );

    let mut late = release(w.two_signers());
    late.public.deadline = DEADLINE + 1;
    assert_refuses(&late, release_rule::NOT_ESCROW_DEADLINE);

    let mut other_funder = release(w.two_signers());
    other_funder.public.funder_identity = w.payee.identity;
    assert_refuses(&other_funder, release_rule::NOT_FUNDERS_ESCROW);

    // Re-creating the remainder under another viewing key would hide it from
    // the funder, who then could not build the refund.
    let mut hidden = release(w.two_signers());
    hidden.private.escrow_owner = escrow_authority(&w.funder.payer)
        .address(w.payee.keypair.viewing_pubkey())
        .expect("other address");
    assert_refuses(&hidden, release_rule::NOT_ESCROW_ADDRESS);

    // Paying anyone but the committed payee, even an approver.
    let mut redirected = release(w.two_signers());
    redirected.private.payee = w.approvers[0].address;
    assert_refuses(&redirected, release_rule::NOT_ESCROW_PAYEE);
}

#[test]
fn the_last_release_pays_what_is_left_and_an_empty_escrow_is_refused() {
    let w = world();
    // 700 at 300 a tranche: 300, 300, then the last 100.
    let spp = w
        .create(700, TRANCHE, 2, w.approver_ids())
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("create");
    let (mut escrow, mut terms) = w.escrow_from(&spp, create_slot::ESCROW);
    for (paid, left) in [(300, 400), (300, 100), (100, 0)] {
        let release = w.release(escrow, terms, w.two_signers());
        let spp = release
            .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
            .expect("release");
        assert_eq!(
            spp.output_utxos
                .get(release_slot::PAYOUT)
                .expect("payout")
                .amount,
            paid
        );
        (escrow, terms) = w.escrow_from(&spp, release_slot::ESCROW);
        assert_eq!(escrow.utxo.amount, left);
    }
    assert_refuses(
        &w.release(escrow, terms, w.two_signers()),
        release_rule::EMPTY_ESCROW,
    );
}

#[test]
fn refund_returns_the_rest_to_the_funder_only() {
    let w = world();
    let (escrow, terms, _) = w.created_escrow();
    let refund_of = |funder_identity, deadline| Refund {
        private: RefundPrivateInputs {
            tx_context: TxContext::new(),
            escrow: escrow.clone(),
            terms: terms.clone(),
        },
        public: RefundPublicInputs {
            deadline,
            funder_identity,
        },
    };
    let ok = refund_of(w.funder.identity, DEADLINE);
    assert_eq!(assert_accepts(&ok), 6_121);
    assert_refuses(
        &refund_of(w.payee.identity, DEADLINE),
        refund_rule::NOT_FUNDER,
    );
    assert_refuses(
        &refund_of(w.funder.identity, DEADLINE - 1),
        refund_rule::NOT_ESCROW_DEADLINE,
    );

    let spp = ok
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("refund proof inputs");
    let proof = compressed(&prover::<Refund>("refund").prove(&ok).expect("proof").proof);
    let hash = spp.padding_independent_private_tx_hash().expect("hash");
    refund::Verifier {
        proof: &proof,
        public_inputs: refund::PublicInputs {
            deadline: DEADLINE,
            funder_identity: w.funder.identity,
        },
        private_tx_hash: &hash,
        transfers: &[],
    }
    .verify()
    .expect("refund verifies");
}

/// No private variable is left free in any instruction, across witness
/// shapes: two and three signers, a partial last tranche, a refund. What the
/// check tolerates is the UTXO metadata the pool's own proof validates and the
/// inverse hints of equality tests, which are free by design.
#[test]
fn no_instruction_leaves_a_private_variable_free() {
    let w = world();
    assert_no_free_variables(&w.valid_create());
    assert_no_free_variables(&w.create(700, TRANCHE, 3, w.approver_ids()));
    let (escrow, terms, _) = w.created_escrow();
    assert_no_free_variables(&w.release(escrow.clone(), terms.clone(), w.two_signers()));
    assert_no_free_variables(&w.release(escrow.clone(), terms.clone(), w.approver_ids()));
    let partial = w
        .create(400, TRANCHE, 2, w.approver_ids())
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("create");
    let (small, small_terms) = w.escrow_from(&partial, create_slot::ESCROW);
    let first = w
        .release(small, small_terms, w.two_signers())
        .create_proof_inputs_and_encrypt_with_keys(&w.funder.keypair, w.funder.payer, u64::MAX)
        .expect("first release");
    let (rest, rest_terms) = w.escrow_from(&first, release_slot::ESCROW);
    assert_no_free_variables(&w.release(rest, rest_terms, w.two_signers()));
    assert_no_free_variables(&Refund {
        private: RefundPrivateInputs { tx_context: TxContext::new(), escrow, terms },
        public: RefundPublicInputs { deadline: DEADLINE, funder_identity: w.funder.identity },
    });
}
