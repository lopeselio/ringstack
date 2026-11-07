use spr_keypair::ShieldedAddress;
use spr_program::ZkProgramCircuit;
use spr_program::{
    circuit::{
        zero, Assert, CheckedTransaction, Circuit, ConfidentialTransaction, DataUtxo, PublicInputs,
        TokenUtxos, Uint, UtxoTrait, U16,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use spr_transaction::WalletUtxo;

use super::EscrowTermsCircuit;
use crate::APPROVERS;

pub const CREATE_TOKEN_INPUTS: usize = 5;

pub mod rule {
    pub const NOTHING_ESCROWED: &str = "the escrow holds nothing";
    pub const ZERO_TRANCHE: &str = "the tranche is zero";
    pub const TRANCHE_TOO_LARGE: &str = "the tranche exceeds the escrow";
    pub const ZERO_THRESHOLD: &str = "the threshold is zero";
    pub const DUPLICATE_APPROVER: &str = "an approver is listed twice";
    pub const UNREACHABLE_THRESHOLD: &str = "the threshold exceeds the approvers";
    pub const NOT_FUNDERS_TOKENS: &str = "the signer does not own the escrowed tokens";
}

#[derive(Clone, ZkProgramCircuit)]
pub struct Create {
    pub private: CreatePrivateInputs,
    pub public: CreatePublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct CreatePrivateInputs {
    pub tx_context: TxContext,
    #[max_len(CREATE_TOKEN_INPUTS)]
    pub token_utxos_asset_a: Vec<WalletUtxo>,
    pub amount: u64,
    pub payee: [u8; 32],
    pub approvers: [[u8; 32]; APPROVERS],
    pub threshold: u16,
    pub tranche: u64,
    pub deadline: u64,
}

#[derive(Clone, PublicInputs)]
pub struct CreatePublicInputs {
    pub escrow_owner: ShieldedAddress,
    pub funder_identity: [u8; 32],
}

impl Circuit for CreateCircuit {
    type Output = CheckedTransaction;

    fn circuit(&self) -> Result<Self::Output, CircuitError> {
        let p = &self.private;
        p.amount.assert_not_zero(rule::NOTHING_ESCROWED)?;
        p.tranche.assert_not_zero(rule::ZERO_TRANCHE)?;
        p.tranche
            .assert_less_or_equal(&p.amount, rule::TRANCHE_TOO_LARGE)?;
        p.threshold.assert_not_zero(rule::ZERO_THRESHOLD)?;

        // Terms no approval could ever meet would lock the funds until the
        // deadline: listed approvers must be distinct and at least M.
        let mut listed = Vec::with_capacity(APPROVERS);
        for approver in &p.approvers {
            listed.push(approver.is_equal(&zero())?.not());
        }
        for (i, (approver, is_listed)) in p.approvers.iter().zip(&listed).enumerate() {
            for later in &p.approvers[i + 1..] {
                approver
                    .is_equal(later)?
                    .and(is_listed)
                    .assert_false(rule::DUPLICATE_APPROVER)?;
            }
        }
        let flags: [Uint<1>; APPROVERS] = core::array::from_fn(|i| Uint::from(listed[i].clone()));
        let count: U16 = Uint::sum::<16, APPROVERS>(&flags);
        p.threshold
            .assert_less_or_equal(&count, rule::UNREACHABLE_THRESHOLD)?;

        let mut tokens = TokenUtxos::new_mut(&p.token_utxos_asset_a)?;
        tokens
            .owner()
            .key()
            .identity()?
            .assert_equal(&self.public.funder_identity, rule::NOT_FUNDERS_TOKENS)?;
        let mut escrow = DataUtxo::<EscrowTermsCircuit>::new_init(&self.public.escrow_owner)
            .with_asset(&tokens.asset())?;
        tokens.transfer(&mut escrow, &p.amount)?;
        escrow.funder = tokens.owner();
        // Set from where the escrow is created, so it is right by construction.
        escrow.escrow_address = self.public.escrow_owner.hash()?;
        escrow.payee = p.payee.clone();
        escrow.approvers = p.approvers.clone();
        escrow.threshold = p.threshold.clone();
        escrow.tranche = p.tranche.clone();
        escrow.deadline = p.deadline.clone();

        ConfidentialTransaction::new(&p.tx_context, &self.public)
            .with(tokens)
            .with(escrow)
            .check()
    }
}
