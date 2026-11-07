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

pub mod rule {
    pub const NOT_FUNDER: &str = "the signer is not the escrow's funder";
    pub const NOT_ESCROW_DEADLINE: &str = "the deadline is not the escrow's";
}

#[derive(Clone, ZkProgramCircuit)]
pub struct Refund {
    pub private: RefundPrivateInputs,
    pub public: RefundPublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct RefundPrivateInputs {
    pub tx_context: TxContext,
    pub escrow: WalletUtxo,
    pub terms: EscrowTerms,
}

#[derive(Clone, PublicInputs)]
pub struct RefundPublicInputs {
    /// Checked against the clock by the program: refunds open after it.
    pub deadline: u64,
    pub funder_identity: [u8; 32],
}

impl Circuit for RefundCircuit {
    type Output = CheckedTransaction;

    fn circuit(&self) -> Result<Self::Output, CircuitError> {
        let p = &self.private;
        let mut escrow = DataUtxo::new_mut(&p.escrow, &p.terms)?.close();
        escrow
            .funder
            .key()
            .identity()?
            .assert_equal(&self.public.funder_identity, rule::NOT_FUNDER)?;
        self.public
            .deadline
            .assert_equal(&escrow.deadline, rule::NOT_ESCROW_DEADLINE)?;
        let mut payout = TokenUtxos::new_init(&escrow.funder, &escrow.asset());
        escrow.transfer_all(&mut payout)?;

        ConfidentialTransaction::new(&p.tx_context, &self.public)
            .with(escrow)
            .with(payout)
            .check()
    }
}
