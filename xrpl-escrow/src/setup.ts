// One-time setup: fund the three testnet wallets from the faucet and create
// the oracle's vault key, the service tokens and the verdict key, all saved
// in .env. Run before starting the services by hand.
import { connectTestnet } from "./config.js";
import { ensureLocalSecrets } from "./local-config.js";
import { loadOrFundWallets, xrpBalance } from "./wallets.js";

const client = await connectTestnet();
try {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  for (const [role, w] of Object.entries(wallets)) {
    console.log(`  ${role.padEnd(8)} ${w.address}  ${(await xrpBalance(client, w.address)).toFixed(6)} XRP`);
  }
  console.log("Wallet seeds, the vault key, service tokens and the verdict key are in .env (testnet only, gitignored).");
} finally {
  await client.disconnect();
}
