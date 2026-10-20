// Runs the verified-delivery escrow scenarios on the XRP Ledger testnet and
// prints a report with explorer links and balances.
//
//   1. Happy path:    work matches the spec, oracle releases the fulfillment,
//                     provider finishes the escrow and gains the price.
//   2. Bad delivery:  work does not match, oracle refuses, cancelling early
//                     fails, after the deadline the client is refunded.
//   3. Wrong secret:  provider tries a forged fulfillment and the ledger
//                     rejects it; after the deadline even the real one fails,
//                     and the escrow is cancelled.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client, xrpToDrops } from "xrpl";
import { EXPLORER_TX, connectTestnet } from "./config.js";
import { toFulfillment } from "./condition.js";
import {
  cancelEscrow, createEscrow, finishEscrow, getEscrow, waitPastCancelAfter, type TxResult, type EscrowRef,
} from "./escrow.js";
import { JobOracle, sha256Hex } from "./oracle.js";
import { JobRegistry } from "./registry.js";
import { loadOrFundWallets, xrpBalance, type Wallets } from "./wallets.js";

export interface Check { scenario: string; label: string; ok: boolean; detail: string }

export interface ScenarioOptions {
  priceXrp?: number;
  slaSeconds?: number;
  log?: (line: string) => void;
}

export async function runScenarios(client: Client, wallets: Wallets, opts: ScenarioOptions = {}): Promise<Check[]> {
  const price = opts.priceXrp ?? 10;
  const sla = opts.slaSeconds ?? 120;
  const log = opts.log ?? console.log;
  const priceDrops = xrpToDrops(price);
  const { client: payer, provider } = wallets;
  const registry = new JobRegistry();
  const checks: Check[] = [];
  const bal = (address: string) => xrpBalance(client, address);
  const fmt = (n: number) => `${n.toFixed(6)} XRP`;

  let scenario = "";
  const check = (label: string, ok: boolean, detail = "") => {
    checks.push({ scenario, label, ok, detail });
    log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  };
  const tx = (label: string, r: TxResult, expected: string) =>
    check(`${label} -> ${expected}`, r.code === expected, `${r.code} ${EXPLORER_TX}${r.hash}`);

  // The work everyone agreed on, and a delivery that does not match it.
  const goodWork = "summary-v1: escrow locks XRP until the oracle releases the fulfillment\n";
  const badWork = "summary-v1: something else\n";
  const expectedHash = sha256Hex(goodWork);

  async function openJob(id: string) {
    const oracle = new JobOracle(); // only the oracle ever holds the secret
    registry.create({
      id, client: payer.address, provider: provider.address, priceDrops, expectedHash, slaSeconds: sla,
      condition: oracle.condition,
    });
    const created = await createEscrow(client, payer, provider.address, priceDrops, oracle.condition, sla);
    tx("EscrowCreate", created, "tesSUCCESS");
    registry.update(id, { offerSequence: created.escrow.offerSequence, cancelAfter: created.escrow.cancelAfter, status: "escrowed" });
    return { oracle, escrow: created.escrow };
  }

  // ---- 1. Happy path ------------------------------------------------------
  scenario = "1. Happy path";
  log(`\n${scenario}: work passes, provider is paid ${price} XRP`);
  const providerBefore = await bal(provider.address);
  const job1 = await openJob("job-1");
  registry.update("job-1", { status: "delivered" });
  const f1 = job1.oracle.verify(goodWork, expectedHash);
  check("oracle accepts the deliverable", f1 !== null, "sha256 matches the job spec");
  if (f1) {
    const fin = await finishEscrow(client, provider, job1.escrow, f1);
    tx("EscrowFinish with oracle's fulfillment", fin, "tesSUCCESS");
    registry.update("job-1", { status: "finished" });
  }
  const providerAfter = await bal(provider.address);
  const gained = providerAfter - providerBefore;
  log(`  provider balance ${fmt(providerBefore)} -> ${fmt(providerAfter)}`);
  check(`provider gains the price minus the finish fee`, gained > price - 0.01 && gained <= price, `+${fmt(gained)}`);
  check("escrow object is gone", (await getEscrow(client, job1.escrow)) === null);

  // Scenarios 2 and 3 both need the deadline to pass, so open both first and wait once.
  // ---- 2. Bad delivery (before deadline) ------------------------------------
  scenario = "2. Bad delivery";
  log(`\n${scenario}: oracle refuses, client is refunded after the deadline`);
  const clientBefore2 = await bal(payer.address);
  const job2 = await openJob("job-2");
  registry.update("job-2", { status: "delivered" });
  const f2 = job2.oracle.verify(badWork, expectedHash);
  check("oracle refuses the deliverable", f2 === null, "sha256 does not match the job spec");
  tx("EscrowCancel before CancelAfter", await cancelEscrow(client, payer, job2.escrow), "tecNO_PERMISSION");

  // ---- 3. Wrong secret (before deadline) ------------------------------------
  scenario = "3. Wrong secret";
  log(`\n${scenario}: the ledger rejects a forged fulfillment`);
  const job3 = await openJob("job-3");
  const forged = toFulfillment(randomBytes(32));
  tx("EscrowFinish with a forged fulfillment", await finishEscrow(client, provider, job3.escrow, forged), "tecCRYPTOCONDITION_ERROR");
  check("escrow stays open", (await getEscrow(client, job3.escrow)) !== null);

  log(`\nWaiting for a validated ledger past CancelAfter (about ${sla} s)...`);
  await waitPastCancelAfter(client, latest(job2.escrow, job3.escrow));

  // ---- 2. Bad delivery (after deadline) -------------------------------------
  scenario = "2. Bad delivery";
  log(`\n${scenario} (after deadline)`);
  const beforeCancel = await bal(payer.address);
  tx("EscrowCancel after CancelAfter", await cancelEscrow(client, payer, job2.escrow), "tesSUCCESS");
  registry.update("job-2", { status: "cancelled" });
  const clientAfter2 = await bal(payer.address);
  const refunded = clientAfter2 - beforeCancel;
  check("client gets the price back minus the cancel fee", refunded > price - 0.01 && refunded <= price, `+${fmt(refunded)}`);
  log(`  client balance ${fmt(clientBefore2)} -> ${fmt(clientAfter2)} (net cost ${fmt(clientBefore2 - clientAfter2)}: scenario 2 and 3 fees plus job 3 still locked)`);
  check("escrow object is gone", (await getEscrow(client, job2.escrow)) === null);

  // ---- 3. Wrong secret (after deadline) -------------------------------------
  scenario = "3. Wrong secret";
  log(`\n${scenario} (after deadline)`);
  const late = job3.oracle.verify(goodWork, expectedHash);
  check("oracle would release for good work", late !== null);
  if (late) {
    tx("EscrowFinish after CancelAfter, even with the real fulfillment", await finishEscrow(client, provider, job3.escrow, late), "tecNO_PERMISSION");
  }
  const beforeCancel3 = await bal(payer.address);
  tx("EscrowCancel after CancelAfter", await cancelEscrow(client, payer, job3.escrow), "tesSUCCESS");
  registry.update("job-3", { status: "cancelled" });
  const afterCancel3 = await bal(payer.address);
  log(`  client balance ${fmt(beforeCancel3)} -> ${fmt(afterCancel3)}`);
  check("escrow object is gone", (await getEscrow(client, job3.escrow)) === null);

  return checks;
}

const latest = (...escrows: EscrowRef[]) => escrows.reduce((a, b) => (b.cancelAfter > a.cancelAfter ? b : a));

async function main() {
  const client = await connectTestnet();
  try {
    console.log(`Connected to ${client.url} (testnet). Loading or funding wallets from the faucet...`);
    const wallets = await loadOrFundWallets(client);
    for (const [role, w] of Object.entries(wallets)) {
      console.log(`  ${role.padEnd(8)} ${w.address}  ${(await xrpBalance(client, w.address)).toFixed(6)} XRP`);
    }
    const checks = await runScenarios(client, wallets);
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    for (const c of failed) console.log(`  FAILED  ${c.scenario}: ${c.label} ${c.detail}`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await client.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
