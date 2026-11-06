//! Building blocks for SPP ZK programs written in `spr-program`'s circuit DSL.
//!
//! The DSL already constrains UTXO hashing, ownership, conservation and range
//! checks, so nothing here rebuilds those. This crate holds the layer above:
//! binding committed terms to what a program checks, timelocks, M-of-N
//! approvals and allowlists.
//!
//! Features: `circuit` for the gadgets used inside a `circuit` fn, `harness`
//! for the checks every gadget is tested with ([`harness`]).

#![forbid(unsafe_code)]
#![deny(unused_must_use)]

#[cfg(feature = "harness")]
pub mod harness;
