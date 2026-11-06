//! The template's circuits, proved with the committed keys and checked by the
//! generated verifier modules exactly as the program calls them.

use std::path::{Path, PathBuf};

use ringstack_zk_gadgets::harness::{assert_accepts, assert_refuses};
use spr_hasher::primitives::solana_owner_identity;
use spr_program::{
    verifier::VerifyError, CompressedProof, Groth16Keys, Groth16Prover, SolanaProof, TxContext,
    ZkProgramCircuit,
};
use zk_template::{
    circuits::{
        vault_authority, Lock, LockPrivateInputs, LockPublicInputs, Release, ReleasePrivateInputs,
        ReleasePublicInputs, VaultTerms,
    },
    instructions::lock::slot,
    verifier::{lock, release},
};

#[allow(dead_code)]
mod shared;
use shared::{keypair, token_input, TREE_ID};

const UNLOCK: u64 = 1_700_000_000;

fn keys_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("keys")
}

/// The committed proving key, checked against its committed digest.
fn prover<P: ZkProgramCircuit>(name: &str) -> Groth16Prover<P> {
    let dir = keys_dir();
    let digest = std::fs::read_to_string(dir.join(format!("{name}.pk.sha256"))).expect("digest");
    let hex = digest.split_whitespace().next().expect("hex digest");
    let checksum: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes");
    let keys = Groth16Keys::load_checked(&dir.join(format!("{name}.pk")), &checksum)
        .expect("committed proving key");
    Groth16Prover::new(keys).expect("prover for this circuit")
}

fn compressed(proof: &SolanaProof) -> CompressedProof {
    CompressedProof::try_from(proof).expect("compressed proof")
}

struct Party {
    keypair: spr_keypair::ShieldedKeypair,
    payer: pinocchio::Address,
    identity: [u8; 32],
}

fn creator() -> Party {
    let keypair = keypair(5);
    let payer = keypair
        .shielded_address()
        .and_then(|address| address.solana_address())
        .expect("payer");
    let identity = solana_owner_identity(payer.as_array()).expect("identity");
    Party {
        keypair,
        payer,
        identity,
    }
}

fn lock_inputs(party: &Party, amount: u64) -> Lock {
    let authority = vault_authority(&party.payer);
    Lock {
        private: LockPrivateInputs {
            tx_context: TxContext::new(),
            token_utxos_asset_a: vec![
                token_input(&party.keypair, 600, 0),
                token_input(&party.keypair, 400, 1),
            ],
            unlock: UNLOCK,
            amount,
        },
        public: LockPublicInputs {
            vault_owner: authority
                .address(party.keypair.viewing_pubkey())
                .expect("vault owner"),
            creator_identity: party.identity,
        },
    }
}

#[test]
fn lock_then_release_with_the_committed_keys() {
    let party = creator();
    let authority = vault_authority(&party.payer);

    let lock = lock_inputs(&party, 250);
    let lock_spp = lock
        .create_proof_inputs_and_encrypt_with_keys(&party.keypair, party.payer, u64::MAX)
        .expect("lock proof inputs");
    let lock_proof = prover::<Lock>("lock").prove(&lock).expect("lock proof");
    let private_tx_hash = lock_spp
        .padding_independent_private_tx_hash()
        .expect("hash");
    let vault_owner = lock
        .public
        .vault_owner
        .address_hash()
        .expect("address hash");
    let proof = compressed(&lock_proof.proof);
    let mut verifier = lock::Verifier {
        proof: &proof,
        public_inputs: lock::PublicInputs {
            vault_owner,
            creator_identity: party.identity,
        },
        private_tx_hash: &private_tx_hash,
        transfers: &[],
    };
    verifier
        .verify()
        .expect("the program's verifier accepts the lock proof");

    // The proof is bound to this transaction and these public inputs.
    let mut other = private_tx_hash;
    other[0] ^= 1;
    verifier.private_tx_hash = &other;
    assert_eq!(verifier.verify(), Err(VerifyError::Proof));
    verifier.private_tx_hash = &private_tx_hash;
    verifier.public_inputs.creator_identity = creator_identity_of(9);
    assert_eq!(verifier.verify(), Err(VerifyError::Proof));

    let output = lock_spp
        .output_utxos
        .get(slot::VAULT)
        .expect("vault output");
    let mut vault = authority
        .input(output, lock_spp.output_tree_id, 2)
        .expect("vault input");
    vault.latest_tree_id = Some(TREE_ID);
    let terms: VaultTerms =
        borsh::from_slice(output.data.utxo_data().expect("vault data")).expect("vault terms");
    assert_eq!(terms.unlock, UNLOCK);

    let release = Release {
        private: ReleasePrivateInputs {
            tx_context: TxContext::new(),
            vault,
            terms,
        },
        public: ReleasePublicInputs {
            unlock: UNLOCK,
            creator_identity: party.identity,
        },
    };
    let release_spp = release
        .create_proof_inputs_and_encrypt_with_keys(&party.keypair, party.payer, u64::MAX)
        .expect("release proof inputs");
    let release_proof = prover::<Release>("release")
        .prove(&release)
        .expect("release proof");
    let proof = compressed(&release_proof.proof);
    let hash = release_spp
        .padding_independent_private_tx_hash()
        .expect("hash");
    let mut verifier = release::Verifier {
        proof: &proof,
        public_inputs: release::PublicInputs {
            unlock: UNLOCK,
            creator_identity: party.identity,
        },
        private_tx_hash: &hash,
        transfers: &[],
    };
    verifier
        .verify()
        .expect("the program's verifier accepts the release proof");
    // An earlier unlock time is what a dishonest caller would pass the program.
    verifier.public_inputs.unlock = UNLOCK - 1;
    assert_eq!(verifier.verify(), Err(VerifyError::Proof));
}

fn creator_identity_of(seed: u8) -> [u8; 32] {
    let other = keypair(seed)
        .shielded_address()
        .and_then(|a| a.solana_address())
        .expect("address");
    solana_owner_identity(other.as_array()).expect("identity")
}

#[test]
fn lock_rules_each_refuse_their_case() {
    let party = creator();
    assert_eq!(assert_accepts(&lock_inputs(&party, 250)), 14_880);
    assert_refuses(&lock_inputs(&party, 0), "the vault locks nothing");
    let mut stranger = lock_inputs(&party, 250);
    stranger.public.creator_identity = creator_identity_of(9);
    assert_refuses(&stranger, "the signer does not own the vaulted tokens");
}

/// A release of the vault a fresh lock creates.
fn release_inputs(party: &Party) -> Release {
    let lock = lock_inputs(party, 250);
    let spp = lock
        .create_proof_inputs_and_encrypt_with_keys(&party.keypair, party.payer, u64::MAX)
        .expect("lock proof inputs");
    let output = spp.output_utxos.get(slot::VAULT).expect("vault output");
    let mut vault = vault_authority(&party.payer)
        .input(output, spp.output_tree_id, 2)
        .expect("vault input");
    vault.latest_tree_id = Some(TREE_ID);
    let terms: VaultTerms =
        borsh::from_slice(output.data.utxo_data().expect("vault data")).expect("vault terms");
    Release {
        private: ReleasePrivateInputs {
            tx_context: TxContext::new(),
            vault,
            terms,
        },
        public: ReleasePublicInputs {
            unlock: UNLOCK,
            creator_identity: party.identity,
        },
    }
}

#[test]
fn release_rules_each_refuse_their_case() {
    let party = creator();
    assert_eq!(assert_accepts(&release_inputs(&party)), 5_638);

    let mut early = release_inputs(&party);
    early.public.unlock = UNLOCK - 1;
    assert_refuses(&early, "the unlock time is not the vault's");

    let mut stranger = release_inputs(&party);
    stranger.public.creator_identity = creator_identity_of(9);
    assert_refuses(&stranger, "the signer is not the vault creator");
}
