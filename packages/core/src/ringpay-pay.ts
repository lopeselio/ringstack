/**
 * Paying a `ringpay:` request from a RingSession (spec/ringpay-uri.md,
 * "Paying a request"). The caller shows the request and gets the payer's
 * confirmation before calling `payRequest`.
 */
import { SOL_MINT, fetchAssetMetadata } from "@heliuslabs/spr";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";

import { encodeReceipt, type Cluster, type Receipt } from "./receipt.ts";
import { fetchShieldedTransaction, issueReceipt } from "./receipt-open.ts";
import { RingPayError, orderMemo, parsePaymentRequest, toBaseUnits, type PaymentRequest } from "./ringpay.ts";
import type { ConfirmedTransaction } from "./send.ts";
import type { RingSession } from "./session.ts";

export interface PayRequestOptions {
  /** The cluster this wallet is on; the request must name the same one. */
  readonly cluster: Cluster;
  /** Base units, for requests without `amount` (the payer chooses). Must match `amount` when both are set. */
  readonly amount?: bigint;
}

export interface PaidRequest {
  readonly request: PaymentRequest;
  readonly amount: bigint;
  readonly payment: ConfirmedTransaction;
  readonly receipt: Receipt;
  /** `ringrcpt1:…`, ready to share with the merchant or a verifier. */
  readonly receiptLink: string;
}

/** Checks a request against the chain without paying it: cluster, registration, amount in base units. */
export async function prepareRequest(
  session: RingSession,
  request: PaymentRequest | string,
  options: PayRequestOptions,
): Promise<{ request: PaymentRequest; amount: bigint }> {
  const req = typeof request === "string" ? parsePaymentRequest(request) : request;
  if (req.cluster !== options.cluster) {
    throw new RingPayError("WRONG_CLUSTER", `request is for ${req.cluster}; this wallet is on ${options.cluster}`);
  }
  if (!(await isWalletRegistered({ rpc: session.client, owner: req.recipient }))) {
    throw new RingPayError(
      "NOT_REGISTERED",
      `${req.recipient} is not registered for private payments; paying it would be public`,
    );
  }
  const decimals = req.mint === SOL_MINT ? 9 : (await fetchAssetMetadata(session.client, req.mint)).decimals;
  let amount: bigint;
  if (req.amount !== undefined) {
    amount = toBaseUnits(req.amount, decimals);
    if (options.amount !== undefined && options.amount !== amount) {
      throw new RingPayError("AMOUNT_MISMATCH", `request asks for ${amount} base units, not ${options.amount}`);
    }
  } else if (options.amount !== undefined && options.amount > 0n) {
    amount = options.amount;
  } else {
    throw new RingPayError("AMOUNT_REQUIRED", "request has no amount; pass one");
  }
  return { request: req, amount };
}

/** Validate, pay privately with the order memo, and issue the payer's receipt. */
export async function payRequest(
  session: RingSession,
  request: PaymentRequest | string,
  options: PayRequestOptions,
): Promise<PaidRequest> {
  const { request: req, amount } = await prepareRequest(session, request, options);
  const payment = await session.transfer(req.recipient, amount, {
    asset: req.mint,
    ...(req.order === undefined ? {} : { memo: orderMemo(req.order) }),
  });
  const tx = await fetchShieldedTransaction(session.client, payment.signature);
  const receipt = issueReceipt(session.keypair, tx, options.cluster);
  return { request: req, amount, payment, receipt, receiptLink: encodeReceipt(receipt) };
}
