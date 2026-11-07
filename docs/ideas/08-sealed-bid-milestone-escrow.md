# 8. Sealed-bid auctions & milestone escrow

**Status:** Milestone escrow built ([zk/milestone-escrow](../../zk/milestone-escrow), on devnet); sealed-bid auctions in backlog · **Type:** ZK program

## Ideas
- **Sealed-bid auction:** bids are private UTXOs owned by an auction PDA, with the bid amount committed in `program_data`. At close, a proof selects the max bid; the winner's UTXO goes to the seller and losers reclaim theirs. Only the winning price (optionally) becomes public.
- **Milestone escrow:** funder escrows a private balance released in tranches when M-of-N approvers sign off, with a timelock refund path. For grants, freelancing, and vesting.

## Primitives
PDA-owned UTXOs, `program_data`, SPP CPI, gadgets: `range`, `threshold`, `timelock`, `terms`.

## Open questions
- Auction close needs all bids as circuit inputs. Bounded by the max-input variant (49) and tx size. May need multi-round reduction.
