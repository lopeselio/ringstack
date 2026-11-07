use solana_program_error::ProgramError;
use spr_hasher::HasherError;
use spr_program::verifier::VerifyError;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[repr(u32)]
pub enum EscrowError {
    #[error("proof verification failed")]
    ProofVerificationFailed = 9000,
    #[error("instruction data is invalid")]
    InvalidInstructionData = 9001,
    #[error("shielded-pool program account is invalid")]
    InvalidShieldedPoolProgram = 9002,
    #[error("escrow-authority account is missing from the transact account list")]
    MissingEscrowAuthority = 9003,
    #[error("hashing failed")]
    HashingFailed = 9004,
    #[error("the escrow has not reached its deadline")]
    NotExpired = 9005,
    #[error("the escrow is past its deadline")]
    Expired = 9006,
    #[error("more approvers than the escrow has slots")]
    TooManyApprovers = 9007,
}

impl From<EscrowError> for ProgramError {
    fn from(error: EscrowError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

impl From<VerifyError> for EscrowError {
    fn from(error: VerifyError) -> Self {
        match error {
            VerifyError::PublicInputs => Self::HashingFailed,
            VerifyError::Proof => Self::ProofVerificationFailed,
        }
    }
}

impl From<HasherError> for EscrowError {
    fn from(_: HasherError) -> Self {
        Self::HashingFailed
    }
}
