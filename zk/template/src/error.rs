use solana_program_error::ProgramError;
use spr_hasher::HasherError;
use spr_program::verifier::VerifyError;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    #[error("proof verification failed")]
    ProofVerificationFailed = 9000,
    #[error("instruction data is invalid")]
    InvalidInstructionData = 9001,
    #[error("shielded-pool program account is invalid")]
    InvalidShieldedPoolProgram = 9002,
    #[error("vault-authority account is missing from the transact account list")]
    MissingVaultAuthority = 9003,
    #[error("hashing failed")]
    HashingFailed = 9004,
    #[error("vault has not yet unlocked")]
    NotYetUnlocked = 9005,
}

impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

impl From<VerifyError> for VaultError {
    fn from(error: VerifyError) -> Self {
        match error {
            VerifyError::PublicInputs => Self::HashingFailed,
            VerifyError::Proof => Self::ProofVerificationFailed,
        }
    }
}

impl From<HasherError> for VaultError {
    fn from(_: HasherError) -> Self {
        Self::HashingFailed
    }
}
