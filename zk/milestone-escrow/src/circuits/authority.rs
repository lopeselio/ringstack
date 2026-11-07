use pinocchio::Address;
use spr_program::ProgramOwner;

use crate::{escrow_authority_seeds, ID};

pub fn escrow_authority(funder: &Address) -> ProgramOwner {
    ProgramOwner::find(&escrow_authority_seeds(funder), &ID)
}
