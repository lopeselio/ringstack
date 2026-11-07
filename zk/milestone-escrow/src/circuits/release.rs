use ringstack_zk_gadgets::threshold::assert_threshold;
use spr_keypair::ShieldedAddress;
use spr_program::ZkProgramCircuit;
use spr_program::{
    circuit::{
        Assert, CheckedTransaction, Circuit, ConfidentialTransaction, DataUtxo, PublicInputs,
        TokenUtxos, UtxoTrait,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use spr_transaction::WalletUtxo;

use super::EscrowTerms;
use crate::APPROVERS;

pub mod rule {
    pub const NOT_FUNDERS_ESCROW: &str = "the escrow is not this funder's";
    pub const NOT_ESCROW_DEADLINE: &str = "the deadline is not the escrow's";
    pub const NOT_ESCROW_PAYEE: &str = "the payee is not the escrow's";
    pub const NOT_ESCROW_ADDRESS: &str = "the remainder is not re-created at the escrow's address";
}

#[derive(Clone, ZkProgramCircuit)]
pub struct Release {
    pub private: ReleasePrivateInputs,
    pub public: ReleasePublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct ReleasePrivateInputs {
    pub tx_context: TxContext,
    pub escrow: WalletUtxo,
    pub terms: EscrowTerms,
    /// Entering as an address registers its viewing key, so the payout is
    /// encrypted to the payee; the circuit checks it is the committed one.
    pub payee: ShieldedAddress,
    /// The escrow's address, so the remainder is encrypted to the funder's
    /// viewing key; checked against the committed `escrow_address`.
    pub escrow_owner: ShieldedAddress,
}

#[derive(Clone, PublicInputs)]
pub struct ReleasePublicInputs {
    /// Checked against the clock by the program: releases close at it.
    pub deadline: u64,
    /// Whose escrow authority PDA signs the transact.
    pub funder_identity: [u8; 32],
    /// Identities of the approvers who signed, zero for an empty slot; the
    /// program computes them from the transaction's signers.
    pub signers: [[u8; 32]; APPROVERS],
}

impl Circuit for ReleaseCircuit {
    type Output = CheckedTransaction;

    fn circuit(&self) -> Result<Self::Output, CircuitError> {
        let p = &self.private;
        // Not closed: the remainder stays escrowed under the same terms.
        let mut escrow = DataUtxo::new_mut(&p.escrow, &p.terms)?;
        escrow
            .funder
            .key()
            .identity()?
            .assert_equal(&self.public.funder_identity, rule::NOT_FUNDERS_ESCROW)?;
        self.public
            .deadline
            .assert_equal(&escrow.deadline, rule::NOT_ESCROW_DEADLINE)?;
        p.payee
            .hash()?
            .assert_equal(&escrow.payee, rule::NOT_ESCROW_PAYEE)?;
        p.escrow_owner
            .hash()?
            .assert_equal(&escrow.escrow_address, rule::NOT_ESCROW_ADDRESS)?;
        // The approver set and threshold come from the committed terms, as
        // the gadget's contract requires.
        let _approvals =
            assert_threshold(&escrow.approvers, &escrow.threshold, &self.public.signers)?;

        let tranche = escrow.tranche.clone();
        let mut payout = TokenUtxos::new_init(&p.payee, &escrow.asset());
        escrow.transfer(&mut payout, &tranche)?;

        ConfidentialTransaction::new(&p.tx_context, &self.public)
            .with(escrow)
            .with(payout)
            .check()
    }
}
