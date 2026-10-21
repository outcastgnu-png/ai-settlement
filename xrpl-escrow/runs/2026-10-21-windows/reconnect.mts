// Windows check: watcher resubscribe-on-reconnect. Runs the repo's LedgerWatcher on its own
// connection, drops that WebSocket abruptly (close 1006, like a network cut), lets xrpl.js
// reconnect, then funds and claims a job and checks the watcher still drives its status.
// The npm-started watcher must be stopped first. Run from C:\dev\ai-settlement\xrpl-escrow.
import { createHash } from "node:crypto";
const R = "file:///C:/dev/ai-settlement/xrpl-escrow/src/";
const { connectTestnet, EXPLORER_TX } = await import(R + "config.ts");
const { loadOrFundWallets } = await import(R + "wallets.ts");
const { EscrowKit } = await import(R + "sdk/index.ts");
const { LedgerWatcher } = await import(R + "watcher.ts");
const { readEnvFile } = await import(R + "local-config.ts");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok: boolean, what: string) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`); };
const lines: string[] = [];
const log = (l: string) => { lines.push(l); console.log(`    [watcher] ${l}`); };

const wclient = await connectTestnet();          // the watcher's own connection
const xrpl = await connectTestnet();             // the parties' connection
const w = await loadOrFundWallets(xrpl, ".env");
const kit = new EscrowKit({ xrpl, statusTimeoutMs: 120_000 });

const watcher = new LedgerWatcher(wclient, { serviceToken: readEnvFile().WATCHER_SERVICE_TOKEN!, log });
await watcher.start();
console.log(`\nC. Watcher reconnect (watcher on ${wclient.url})`);

const work = "reconnect deliverable " + new Date().toISOString();
const job = await kit.createJob({ client: w.client.address, provider: w.provider.address, priceDrops: "10000000", slaSeconds: 300,
  spec: { checks: [{ type: "sha256-match", sha256: sha(work) }] } });
for (let i = 0; i < 40 && !lines.some((l) => l.startsWith("subscribed to")); i++) await sleep(250);
check(lines.some((l) => l.startsWith("subscribed to")), `watcher subscribed to the job's accounts before the drop (job ${job.id})`);

const events: string[] = [];
wclient.on("disconnected", (code: number) => events.push(`disconnected ${code}`));
wclient.on("connected", () => events.push("connected"));
const before = lines.length;
(wclient as any).connection.ws.terminate();      // abrupt drop, no close handshake
for (let i = 0; i < 120 && !events.includes("connected"); i++) await sleep(250);
check(events[0]?.startsWith("disconnected") && events.includes("connected"), `socket dropped and xrpl.js reconnected (${events.join(", ")})`);
for (let i = 0; i < 40 && !lines.slice(before).some((l) => l.startsWith("subscribed to")); i++) await sleep(250);
check(lines.slice(before).some((l) => l.startsWith("subscribed to")), "watcher resubscribed to the accounts after the reconnect");

const f = await kit.fundJob(job.id, w.client);
check(f.tx.code === "tesSUCCESS" && f.job.status === "funded", `EscrowCreate after reconnect ${f.tx.code}, watcher -> ${f.job.status} ${EXPLORER_TX}${f.tx.hash}`);
const d = await kit.deliver(job.id, w.provider, work);
const subsBeforeClaim = lines.filter((l) => l.startsWith("subscribed to")).length;
const c = await kit.claim(job.id, w.provider, d.fulfillment!);
check(c.tx.code === "tesSUCCESS" && c.job.status === "paid", `EscrowFinish after reconnect ${c.tx.code}, watcher -> ${c.job.status} ${EXPLORER_TX}${c.tx.hash}`);
check(lines.filter((l) => l.startsWith("subscribed to")).length === subsBeforeClaim,
  "paid came from the live transaction stream (no new subscribe/backfill in between)");

console.log(`\nreconnect: ${pass}/${pass + fail} checks passed`);
watcher.stop();
await wclient.disconnect();
await xrpl.disconnect();
process.exit(fail ? 1 : 0);
