// xrpl-tx-validated (EDR-014): passes when the deliverable names a testnet
// transaction that is in a validated ledger, succeeded (tesSUCCESS), and has
// every field the job spec asks for.
//
// The deliverable must be exactly a transaction hash, 64 hex characters, and
// nothing else in it is read. The oracle reads the transaction from its own
// testnet connection (the network_id guard applies) and trusts only what a
// validated ledger says. What it compares:
//
//   txType          Payment or EscrowCreate
//   destination     the transaction's Destination
//   minDrops        XRP in drops, at least this much. For a Payment this is the
//                   amount actually delivered (meta.delivered_amount), never the
//                   Amount field, which a partial payment can overstate
//   account         optional: the sending account
//   destinationTag  optional: the DestinationTag
//   memo            optional: some memo's MemoData, as UTF-8 text, equals this exactly
//
// The transaction must also be in a ledger that closed after the job was
// created (with 10 s of slack for ledger close-time rounding), so a provider
// can't hand in an older payment. A lookup that times out or can't reach the
// ledger is the oracle's problem, not the job's: it throws CheckUnavailable and
// the oracle signs nothing, so the provider asks again.
import { RIPPLE_EPOCH_OFFSET } from "../../config.js";
import { CheckUnavailable } from "./json-schema.js";
import type { CheckContext, CheckResult } from "./types.js";

export const TX_TYPES = ["Payment", "EscrowCreate"] as const;
export const LOOKUP_TIMEOUT_MS = 10_000;
export const CLOSE_TIME_SLACK_MS = 10_000;
export const TX_HASH = /^[0-9A-Fa-f]{64}$/;

export interface TxCheckSpec {
  type: "xrpl-tx-validated";
  txType: (typeof TX_TYPES)[number];
  destination: string;
  minDrops: string;
  account?: string;
  destinationTag?: number;
  memo?: string;
}

/** What a ledger lookup found. `tx` holds the transaction fields, `meta` its metadata. */
export type TxLookupResult =
  | { found: false }
  | { found: true; validated: boolean; tx: Record<string, unknown>; meta: Record<string, unknown> | null; closeTime: number | null };

/** Looks a transaction up by hash on the testnet. */
export type TxLookup = (hash: string) => Promise<TxLookupResult>;

const fail = (detail: string): CheckResult => ({ type: "xrpl-tx-validated", pass: false, detail });

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckUnavailable(`the ledger lookup took longer than ${ms} ms; try again`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const textOfHex = (hex: unknown) => (typeof hex === "string" && /^([0-9A-Fa-f]{2})*$/.test(hex) ? Buffer.from(hex, "hex").toString("utf8") : null);

export async function xrplTxValidated(spec: TxCheckSpec, ctx: CheckContext, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<CheckResult> {
  if (!TX_HASH.test(ctx.content)) return fail("deliverable is not a transaction hash (exactly 64 hex characters)");
  if (!ctx.lookupTx) throw new CheckUnavailable("this oracle has no ledger connection for transaction checks");
  const hash = ctx.content.toUpperCase();
  let found: TxLookupResult;
  try {
    found = await withTimeout(ctx.lookupTx(hash), timeoutMs);
  } catch (err) {
    if (err instanceof CheckUnavailable) throw err;
    throw new CheckUnavailable(`the ledger lookup failed (${err instanceof Error ? err.message : String(err)}); try again`);
  }
  if (!found.found) return fail(`transaction ${hash} was not found on the testnet`);
  if (!found.validated) return fail(`transaction ${hash} is not in a validated ledger`);
  const { tx, meta } = found;
  const result = meta?.TransactionResult;
  if (result !== "tesSUCCESS") return fail(`transaction ${hash} did not succeed: ${String(result ?? "no result")}`);
  if (tx.TransactionType !== spec.txType) return fail(`transaction is a ${String(tx.TransactionType)}, not a ${spec.txType}`);
  if (tx.Destination !== spec.destination) return fail("transaction destination is not the one in the spec");
  if (spec.account !== undefined && tx.Account !== spec.account) return fail("transaction was not sent by the account in the spec");
  if (spec.destinationTag !== undefined && tx.DestinationTag !== spec.destinationTag) return fail("destination tag does not match the spec");
  const amount = spec.txType === "Payment" ? meta?.delivered_amount : tx.Amount;
  if (typeof amount !== "string" || !/^[0-9]{1,17}$/.test(amount)) return fail("transaction did not move XRP");
  if (BigInt(amount) < BigInt(spec.minDrops)) return fail(`transaction moved ${amount} drops, less than the ${spec.minDrops} in the spec`);
  if (spec.memo !== undefined) {
    const memos = Array.isArray(tx.Memos) ? tx.Memos : [];
    const texts = memos.map((m) => textOfHex((m as { Memo?: { MemoData?: unknown } })?.Memo?.MemoData));
    if (!texts.includes(spec.memo)) return fail("no memo on the transaction matches the spec");
  }
  if (found.closeTime === null) return fail("the ledger did not report when the transaction was validated");
  const closedAtMs = (found.closeTime + RIPPLE_EPOCH_OFFSET) * 1000;
  if (closedAtMs + CLOSE_TIME_SLACK_MS < ctx.job.createdAt) return fail("transaction was validated before the job was created");
  return { type: "xrpl-tx-validated", pass: true, detail: `${spec.txType} ${hash} validated with tesSUCCESS, ${amount} drops to the destination` };
}

/** A TxLookup on an xrpl.js client. Only a validated answer counts; anything unvalidated is reported as such. */
export function ledgerTxLookup(client: { request: (r: never) => Promise<unknown> }): TxLookup {
  return async (hash) => {
    let res: { result: Record<string, unknown> };
    try {
      res = (await client.request({ command: "tx", transaction: hash } as never)) as { result: Record<string, unknown> };
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      if (code === "txnNotFound") return { found: false };
      throw err;
    }
    const r = res.result;
    // API v2 puts the fields in tx_json; v1 puts them on the result itself.
    const tx = (r.tx_json as Record<string, unknown> | undefined) ?? r;
    const meta = typeof r.meta === "object" && r.meta !== null ? (r.meta as Record<string, unknown>) : null;
    const date = typeof tx.date === "number" ? tx.date : typeof r.date === "number" ? r.date : null;
    const closeTime = date ?? (typeof r.close_time_iso === "string"
      ? Math.floor(Date.parse(r.close_time_iso) / 1000) - RIPPLE_EPOCH_OFFSET : null);
    return { found: true, validated: r.validated === true, tx, meta, closeTime };
  };
}
