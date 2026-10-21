// Windows check: drive jobs by hand through services started with `npm run registry|oracle|watcher`.
// Run from C:\dev\ai-settlement\xrpl-escrow so .env and data/ resolve.
import { createHash } from "node:crypto";
const R = "file:///C:/dev/ai-settlement/xrpl-escrow/src/";
const { connectTestnet, EXPLORER_TX } = await import(R + "config.ts");
const { loadOrFundWallets, xrpBalance } = await import(R + "wallets.ts");
const { EscrowKit } = await import(R + "sdk/index.ts");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const link = (h: string) => EXPLORER_TX + h;
let pass = 0, fail = 0;
const check = (ok: boolean, what: string) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`); };

const xrpl = await connectTestnet();
console.log(`connected to ${xrpl.url} (network_id checked = 1)`);
const w = await loadOrFundWallets(xrpl, ".env");
const kit = new EscrowKit({ xrpl, statusTimeoutMs: 90_000 });
console.log(`oracle verdict key ${(await kit.oracleInfo()).oracle}, pinned ${kit.oracleAddress}`);
const bal = async () => `client ${await xrpBalance(xrpl, w.client.address)} / provider ${await xrpBalance(xrpl, w.provider.address)} XRP`;

const mode = process.argv[2] ?? "quickstart";

if (mode === "quickstart") {
  console.log(`\nA. Hand-driven job through the npm-started services (pass and claim)\n  before: ${await bal()}`);
  const work = "quickstart deliverable " + new Date().toISOString();
  const job = await kit.createJob({ client: w.client.address, provider: w.provider.address, priceDrops: "10000000", slaSeconds: 300,
    spec: { checks: [{ type: "sha256-match", sha256: sha(work) }] } });
  check(job.status === "draft" && !!job.condition, `createJob -> draft with condition (job ${job.id})`);
  const f = await kit.fundJob(job.id, w.client);
  check(f.tx.code === "tesSUCCESS" && f.job.status === "funded", `fundJob EscrowCreate ${f.tx.code}, watcher -> ${f.job.status} ${link(f.tx.hash)}`);
  const d = await kit.deliver(job.id, w.provider, work);
  check(d.verdict.verdict === "pass" && d.verdictSignatureValid && !!d.fulfillment, `deliver -> verdict=${d.verdict.verdict}, signature valid=${d.verdictSignatureValid}, fulfillment returned=${!!d.fulfillment}, status ${d.job.status}`);
  const c = await kit.claim(job.id, w.provider, d.fulfillment!);
  check(c.tx.code === "tesSUCCESS" && c.job.status === "paid", `claim EscrowFinish ${c.tx.code}, watcher -> ${c.job.status} ${link(c.tx.hash)}`);
  console.log(`  after: ${await bal()}`);
  console.log(`  events: ${(await kit.events(job.id)).map((e: any) => e.status ?? "flag").join(" -> ")}`);
}

if (mode === "expired") {
  console.log(`\nB. expired_unclaimed on testnet: pass, provider never claims\n  before: ${await bal()}`);
  const work = "unclaimed deliverable " + new Date().toISOString();
  const job = await kit.createJob({ client: w.client.address, provider: w.provider.address, priceDrops: "10000000", slaSeconds: 60,
    spec: { checks: [{ type: "sha256-match", sha256: sha(work) }] } });
  const f = await kit.fundJob(job.id, w.client);
  check(f.tx.code === "tesSUCCESS" && f.job.status === "funded", `fundJob EscrowCreate ${f.tx.code}, watcher -> ${f.job.status} ${link(f.tx.hash)} (CancelAfter ${f.job.cancelAfter})`);
  const d = await kit.deliver(job.id, w.provider, work);
  check(d.job.status === "verified_pass" && !!d.fulfillment, `deliver -> ${d.job.status}, fulfillment returned and deliberately not used`);
  const flagged = await kit.waitForStatus(job.id, ["verified_pass"], 5_000);
  const t0 = Date.now();
  const e = await kit.waitForStatus(job.id, ["expired_unclaimed"], 180_000);
  check(e.status === "expired_unclaimed", `watcher -> expired_unclaimed after ${Math.round((Date.now() - t0) / 1000)} s (expiringSoon flag seen: ${flagged.expiringSoon || e.expiringSoon})`);
  const ev = await kit.events(job.id);
  console.log(`  events: ${ev.map((x: any) => `${x.status ?? "flag"}${x.detail ? ` (${x.detail})` : ""}`).join(" | ")}`);
  const r = await kit.refund(job.id, w.client);
  check(r.tx.code === "tesSUCCESS" && r.job.status === "refunded", `refund EscrowCancel ${r.tx.code}, watcher -> ${r.job.status} ${link(r.tx.hash)}`);
  console.log(`  after: ${await bal()}`);
  const rep = await kit.reputation(w.provider.address);
  console.log(`  provider reputation: ${JSON.stringify(rep)}`);
}

console.log(`\n${mode}: ${pass}/${pass + fail} checks passed`);
await xrpl.disconnect();
process.exit(fail ? 1 : 0);
