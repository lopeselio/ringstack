//! Building blocks for SPP ZK programs written in `spr-program`'s circuit DSL.
//!
//! The DSL already constrains UTXO hashing, ownership, conservation and range
//! checks, so nothing here rebuilds those. This crate holds the layer above:
//! binding committed terms to what a program checks, timelocks, M-of-N
//! approvals and allowlists.
//!
//! - [`timelock`]: the program's half of a timelock. No features, `no_std`
//!   friendly, so an onchain program can use it.
//! - [`threshold`] (feature `circuit`): M-of-N approvals against a committed
//!   approver set.
//! - [`allowlist`] (feature `circuit`): membership in a set committed as a
//!   Poseidon Merkle root, and the native tree for the client.
//! - [`harness`] (feature `harness`): the checks every gadget is tested with.
//!
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

#[cfg(feature = "circuit")]
pub mod allowlist;
#[cfg(feature = "harness")]
pub mod harness;
#[cfg(feature = "circuit")]
pub mod threshold;
pub mod timelock;
