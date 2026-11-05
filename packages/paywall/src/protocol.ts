/**
 * The RingPay 402 protocol (x402-style) between an API and a paying agent.
 *
 *   1. GET /resource                       → 402, body `PaymentChallenge`,
 *                                            header RingPay-Request: ringpay:…
 *   2. agent pays the ringpay: request privately; its order id (the nonce)
 *      travels in the encrypted memo of the vendor's output
 *   3. GET /resource + RingPay-Payment: <tx signature>
 *                                          → 200 + RingPay-Settled: <signature>
 *
 * The agent proves nothing beyond the signature: the vendor decrypts its own
 * output with its viewing key. Unlike a receipt, this discloses none of the
 * agent's other outputs (its change, other payees).
 */
export const REQUEST_HEADER = "ringpay-request";
export const PAYMENT_HEADER = "ringpay-payment";
export const SETTLED_HEADER = "ringpay-settled";

export interface PaymentChallenge {
  readonly error: "payment_required";
  /** The `ringpay:` request to pay. Its order id is the nonce. */
  readonly ringpay: string;
  readonly nonce: string;
  /** UI units of `mint`. */
  readonly price: string;
  readonly mint: string;
  readonly expiresAt: string;
  /** Why an attached payment was rejected, when one was. */
  readonly reason?: string;
}
