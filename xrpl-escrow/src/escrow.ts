// The three native escrow transactions. Each is signed locally by the wallet
// that sends it; nothing here ever holds anyone's funds.
import {
  Client, Wallet,
  type EscrowCreate, type EscrowFinish, type EscrowCancel, type LedgerEntry, type SubmittableTransaction,
} from "xrpl";
import { nowRippleTime } from "./config.js";

export interface TxResult {
  hash: string;
  code: string; // engine result from the validated ledger, e.g. tesSUCCESS
  sequence: number;
}

export interface EscrowRef {
  owner: string;
  offerSequence: number;
  condition: string;
  cancelAfter: number; // Ripple epoch seconds
}

/**
 * Sign and submit, then return the result recorded in a validated ledger.
 * submitAndWait can throw on a failed (tec*) transaction, so on any error we
 * look the transaction up by hash and wait for its validated outcome.
 */
export async function submitValidated(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResult> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const sequence = prepared.Sequence as number;
  try {
    const res = await client.submitAndWait(signed.tx_blob);
    return { hash: signed.hash, code: engineResult(res.result.meta), sequence };
  } catch (err) {
    const code = await waitForValidated(client, signed.hash, prepared.LastLedgerSequence as number);
    if (!code) throw err;
    return { hash: signed.hash, code, sequence };
  }
}

function engineResult(meta: unknown): string {
  return typeof meta === "object" && meta && "TransactionResult" in meta ? String(meta.TransactionResult) : "unknown";
}

async function waitForValidated(client: Client, hash: string, lastLedger: number): Promise<string | null> {
  for (;;) {
    try {
      const res = await client.request({ command: "tx", transaction: hash });
      if (res.result.validated) return engineResult(res.result.meta);
    } catch {
      // not found yet
    }
    const validated = await client.getLedgerIndex();
    if (validated > lastLedger) return null; // expired without making it into a ledger
    await sleep(1000);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Client locks `drops` for `provider`, unlockable with `condition` until `slaSeconds` from now. */
export async function createEscrow(
  client: Client, payer: Wallet, provider: string, drops: string, condition: string, slaSeconds: number,
): Promise<TxResult & { escrow: EscrowRef }> {
  const cancelAfter = nowRippleTime() + slaSeconds;
  const tx: EscrowCreate = {
    TransactionType: "EscrowCreate",
    Account: payer.address,
    Destination: provider,
    Amount: drops,
    Condition: condition,
    CancelAfter: cancelAfter,
  };
  const result = await submitValidated(client, payer, tx);
  return { ...result, escrow: { owner: payer.address, offerSequence: result.sequence, condition, cancelAfter } };
}

/** Anyone holding the fulfillment can finish; autofill sets the higher conditional fee. */
export function finishEscrow(client: Client, sender: Wallet, escrow: EscrowRef, fulfillment: string): Promise<TxResult> {
  const tx: EscrowFinish = {
    TransactionType: "EscrowFinish",
    Account: sender.address,
    Owner: escrow.owner,
    OfferSequence: escrow.offerSequence,
    Condition: escrow.condition,
    Fulfillment: fulfillment,
  };
  return submitValidated(client, sender, tx);
}

/** Anyone can cancel once a validated ledger has closed after CancelAfter. */
export function cancelEscrow(client: Client, sender: Wallet, escrow: EscrowRef): Promise<TxResult> {
  const tx: EscrowCancel = {
    TransactionType: "EscrowCancel",
    Account: sender.address,
    Owner: escrow.owner,
    OfferSequence: escrow.offerSequence,
  };
  return submitValidated(client, sender, tx);
}

/** The escrow's ledger object in the latest validated ledger, or null once it is finished or cancelled. */
export async function getEscrow(client: Client, escrow: EscrowRef): Promise<LedgerEntry.Escrow | null> {
  try {
    const res = await client.request({
      command: "ledger_entry",
      escrow: { owner: escrow.owner, seq: escrow.offerSequence },
      ledger_index: "validated",
    });
    return res.result.node as LedgerEntry.Escrow;
  } catch (err) {
    if (String((err as { data?: { error?: string } }).data?.error ?? err).includes("entryNotFound")) return null;
    throw err;
  }
}

/** Ledger close time lags real time, so wait for a validated ledger that closed after CancelAfter. */
export async function waitPastCancelAfter(client: Client, escrow: EscrowRef): Promise<void> {
  for (;;) {
    const res = await client.request({ command: "ledger", ledger_index: "validated" });
    if (res.result.ledger.close_time > escrow.cancelAfter) return;
    await sleep(2000);
  }
}
