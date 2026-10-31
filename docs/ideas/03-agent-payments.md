# 3. Private agent payments (x402-style)

**Status:** Backlog · **Type:** Client-only · **Builds on:** [RingPay receipts](01-ringpay.md)

## Problem
AI agents paying for APIs onchain leak their strategy, budget, and vendor list. Helius lists "agentic commerce" as a target use case.

## Solution
- **MCP server** that gives an agent a private balance with spend limits (per call, per day, per vendor allow-list).
- **HTTP 402 facilitator**: the API responds with a `ringpay:` request; the agent pays privately and retries with a receipt header; the server verifies the receipt (single-tx viewing key) before serving.
- Server middleware for Hono/Express that does the verification.

## Primitives
Encrypted memo (request nonce), transaction viewing key receipts, registry lookup.

## Open questions
- Payment latency (proof + confirmation) vs. API call latency. May need prepaid channels or batched settlement.
- Confidential Ring still exposes agent ↔ vendor addresses. Anonymous ring needed for full unlinkability.
