use spr_program::{
    transaction_hash,
    verifier::{groth16_solana, public_hash, verify_groth16, Field, VerifyError},
    CompressedProof, PublicTransfer,
};

include!("release.vk.rs");

pub struct PublicInputs {
    pub deadline: u64,
    pub funder_identity: [u8; 32],
    pub signers: [[u8; 32]; 3],
}

impl PublicInputs {
    pub fn hash(&self, transaction_hash: &[u8; 32]) -> Result<[u8; 32], VerifyError> {
        let [signers_0, signers_1, signers_2] = &self.signers;
        public_hash(
            &[
                Field::Integer(u128::from(self.deadline)),
                Field::Hash(&self.funder_identity),
                Field::Array(&[
                    Field::Hash(signers_0),
                    Field::Hash(signers_1),
                    Field::Hash(signers_2),
                ]),
            ],
            transaction_hash,
        )
    }
}

pub struct Verifier<'a> {
    pub proof: &'a CompressedProof,
    pub public_inputs: PublicInputs,
    pub private_tx_hash: &'a [u8; 32],
    pub transfers: &'a [PublicTransfer],
}

impl Verifier<'_> {
    pub fn verify(&self) -> Result<(), VerifyError> {
        let transaction_hash = transaction_hash(self.private_tx_hash, self.transfers)
            .map_err(|_| VerifyError::PublicInputs)?;
        verify_groth16(
            self.proof,
            self.public_inputs.hash(&transaction_hash)?,
            &VERIFYINGKEY,
        )
    }
}
