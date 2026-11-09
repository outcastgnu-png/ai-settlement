// Reads the anchors of a verdict log from the ledger itself: the validated,
// successful AccountSet transactions from the anchor account whose memo is an
// anchor for the pinned verdict address. Used by the SDK to check a log, and
// by the oracle before it anchors, so it never extends a chain that disagrees
// with what the ledger already holds (EDR-014, Gpno N29).
import type { Client } from "xrpl";
import { parseAnchorMemo, type Anchor } from "./verdict-log.js";

/** The anchor in one account_tx row, if it is a validated, successful AccountSet from the anchor account. */
export function anchorFromAccountTx(t: Record<string, unknown>, anchorAddress: string, verdictAddress: string): Anchor | null {
  const tx = (t.tx_json ?? t.tx) as Record<string, unknown> | undefined;
  const meta = t.meta as { TransactionResult?: string } | undefined;
  if (t.validated !== true || !tx || meta?.TransactionResult !== "tesSUCCESS") return null;
  if (tx.TransactionType !== "AccountSet" || tx.Account !== anchorAddress) return null;
  const memo = parseAnchorMemo(tx.Memos);
  if (!memo || memo.oracle !== verdictAddress) return null;
  return { ...memo, txHash: String(t.hash ?? tx.hash), ledgerIndex: Number(t.ledger_index ?? tx.ledger_index ?? 0), account: anchorAddress };
}

export interface AnchorHistory {
  /** Newest first. */
  anchors: Anchor[];
  /** False when the account has more transactions than `maxTx` and older ones were not read. */
  complete: boolean;
}

/** Every anchor for `verdictAddress` among the anchor account's latest `maxTx` transactions, newest first. */
export async function listAnchors(client: Client, anchorAddress: string, verdictAddress: string, maxTx = 400): Promise<AnchorHistory> {
  const anchors: Anchor[] = [];
  let marker: unknown;
  let seen = 0;
  do {
    const res = await client.request({
      command: "account_tx", account: anchorAddress, ledger_index_min: -1, ledger_index_max: -1, limit: 100, forward: false,
      ...(marker ? { marker } : {}),
    } as never) as { result: { transactions: Record<string, unknown>[]; marker?: unknown } };
    for (const t of res.result.transactions) {
      seen++;
      const anchor = anchorFromAccountTx(t, anchorAddress, verdictAddress);
      if (anchor) anchors.push(anchor);
    }
    marker = res.result.marker;
  } while (marker && seen < maxTx);
  return { anchors, complete: !marker };
}
