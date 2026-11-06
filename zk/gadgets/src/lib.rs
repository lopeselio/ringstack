//! Building blocks for SPP ZK programs written in `spr-program`'s circuit DSL.
//!
//! The DSL already constrains UTXO hashing, ownership, conservation and range
//! checks, so nothing here rebuilds those. This crate holds the layer above:
//! binding committed terms to what a program checks, timelocks, M-of-N
//! approvals and allowlists.
//!
//! - [`timelock`]: the program's half of a timelock. No features, `no_std`
//!   friendly, so an onchain program can use it.
//! - [`harness`] (feature `harness`): the checks every gadget is tested with.
//!
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

#[cfg(feature = "harness")]
pub mod harness;
pub mod timelock;
