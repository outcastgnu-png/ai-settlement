// Your first job through the local services: the client pays 10 XRP into
// escrow, the provider delivers, the oracle checks the work, and the provider
// claims the payment. Start the services first (npm run registry, npm run
// oracle, npm run watcher), then run from the xrpl-escrow folder:
//
//   npx tsx examples/first-job.ts
import { sha256Hex } from "../src/auth.js";
import { EXPLORER_TX, connectTestnet } from "../src/config.js";
import { EscrowKit } from "../src/sdk/index.js";
import { loadOrFundWallets, xrpBalance } from "../src/wallets.js";

const xrpl = await connectTestnet(); // aborts unless network_id is 1 (testnet)
try {
  const { client, provider } = await loadOrFundWallets(xrpl);
  const kit = new EscrowKit({ xrpl, statusTimeoutMs: 90_000 });
  const balances = async () =>
    `client ${await xrpBalance(xrpl, client.address)} XRP, provider ${await xrpBalance(xrpl, provider.address)} XRP`;
  console.log(`before: ${await balances()}`);

  const work = `my first deliverable ${new Date().toISOString()}`;
  const job = await kit.createJob({
    client: client.address, provider: provider.address, priceDrops: "10000000", slaSeconds: 300,
    spec: { title: "first job", checks: [{ type: "sha256-match", sha256: sha256Hex(work) }] },
  });
  console.log(`job ${job.id} registered, condition ${job.condition}`);

  const funded = await kit.fundJob(job.id, client);
  console.log(`EscrowCreate ${funded.tx.code}, job ${funded.job.status}: ${EXPLORER_TX}${funded.tx.hash}`);

  const delivered = await kit.deliver(job.id, provider, work);
  console.log(`oracle verdict ${delivered.verdict.verdict}, signature valid: ${delivered.verdictSignatureValid}`);

  if (delivered.fulfillment && delivered.verdictSignatureValid) {
    const paid = await kit.claim(job.id, provider, delivered.fulfillment);
    console.log(`EscrowFinish ${paid.tx.code}, job ${paid.job.status}: ${EXPLORER_TX}${paid.tx.hash}`);
  } else {
    console.log("no fulfillment; refunding the client after the deadline ...");
    const refunded = await kit.refund(job.id, client);
    console.log(`EscrowCancel ${refunded.tx.code}, job ${refunded.job.status}: ${EXPLORER_TX}${refunded.tx.hash}`);
  }
  console.log(`after: ${await balances()}`);
} finally {
  await xrpl.disconnect();
}
