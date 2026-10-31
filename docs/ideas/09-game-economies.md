# 9. Hidden-balance game economies

**Status:** Backlog · **Type:** Mixed (client + ZK program)

## Ideas
- **Fog-of-war treasuries:** strategy games where players' war chests and resources are private balances. Opponents see that moves happen, not how rich you are.
- **Private wagers:** match stakes escrowed privately; payout via a game-result proof or oracle.
- **Sealed in-game auctions** reusing [idea 8](08-sealed-bid-milestone-escrow.md).
- Game items as Token-2022 assets held privately (inventory not publicly enumerable).

## Primitives
Private SPL/Token-2022 balances, UTXO `program_data` for game state, PDA escrow.

## Open questions
- Latency: ~proof time + slot confirmation per action. Fine for turn-based games, not real-time.
- Consider pairing with MagicBlock ephemeral rollups for real-time play, settling to Rings.
