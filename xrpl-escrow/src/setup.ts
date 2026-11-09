// One-time setup: fund the three testnet wallets from the faucet and create
// the oracle's vault key, the service tokens, the verdict key and the anchor
// wallet (it puts the verdict log's head on the testnet), all saved
// in .env. Run before starting the services by hand.
import { connectTestnet } from "./config.js";
import { ensureLocalSecrets } from "./local-config.js";
import { loadOrFundAnchor, loadOrFundWallets, xrpBalance } from "./wallets.js";

const client = await connectTestnet();
try {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  const anchor = await loadOrFundAnchor(client);
  for (const [role, w] of [...Object.entries(wallets), ["anchor", anchor] as const]) {
    console.log(`  ${role.padEnd(8)} ${w.address}  ${(await xrpBalance(client, w.address)).toFixed(6)} XRP`);
  }
  console.log("Wallet seeds (the anchor wallet too), the vault key, service tokens and the verdict key are in .env (testnet only, gitignored).");
  console.log("The anchor wallet anchors one verdict log. An oracle with a fresh data folder or a new verdict key needs a fresh anchor wallet,");
  console.log("or it refuses to start: remove ORACLE_ANCHOR_SEED and ORACLE_ANCHOR_ADDRESS from .env and run npm run setup again.");
} finally {
  await client.disconnect();
}
