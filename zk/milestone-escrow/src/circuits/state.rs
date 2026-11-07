use borsh::{BorshDeserialize, BorshSerialize};
use spr_program::{circuit::UtxoState, UtxoOwner};

use crate::APPROVERS;

/// The terms an escrow UTXO commits to. Its data hash binds every field, so
/// a release or refund proof can only use the terms the funder created.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, UtxoState)]
pub struct EscrowTerms {
    /// Who created the escrow and gets the refund.
    pub funder: UtxoOwner,
    /// The escrow's own shielded address hash: its authority PDA with the
    /// funder's viewing key. A release must re-create the remainder at this
    /// address, so whoever builds a release cannot hide the escrow from the
    /// funder (and so block the refund) by encrypting it to another key.
    pub escrow_address: [u8; 32],
    /// The payee's shielded address hash: owner *and* viewing key, so a
    /// payout cannot be encrypted to anyone else.
    pub payee: [u8; 32],
    /// Approver identities (`solana_owner_identity` of each signer), zero for
    /// an unused slot.
    pub approvers: [[u8; 32]; APPROVERS],
    /// Approvals needed per release.
    pub threshold: u16,
    /// Paid to the payee per release.
    pub tranche: u64,
    /// Releases before it, refund after it (unix seconds).
    pub deadline: u64,
}
