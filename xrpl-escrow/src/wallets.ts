// Testnet wallets for the three roles. Seeds live in .env (gitignored) so
// reruns reuse the same accounts; they are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";
import { Client, Wallet } from "xrpl";
import { FAUCET_HOST } from "./config.js";

export type Role = "client" | "provider" | "oracle";
export const ROLES: Role[] = ["client", "provider", "oracle"];
export type Wallets = Record<Role, Wallet>;

const seedKey = (role: Role) => `${role.toUpperCase()}_SEED`;

/** Top up below this balance so a rerun always has enough for a 10 XRP job plus reserves. */
const MIN_BALANCE_XRP = 30;

export async function xrpBalance(client: Client, address: string): Promise<number> {
  try {
    return Number(await client.getXrpBalance(address, { ledger_index: "validated" }));
  } catch {
    return 0; // account not created yet
  }
}

/** Load seeds from envPath, create and faucet-fund any missing or low wallets, save seeds back. */
export async function loadOrFundWallets(client: Client, envPath = ".env"): Promise<Wallets> {
  const env = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const wallets = {} as Wallets;
  for (const role of ROLES) {
    const seed = env[seedKey(role)];
    wallets[role] = seed ? Wallet.fromSeed(seed) : Wallet.generate();
  }
  await Promise.all(
    ROLES.map(async (role) => {
      if ((await xrpBalance(client, wallets[role].address)) < MIN_BALANCE_XRP) {
        await client.fundWallet(wallets[role], { faucetHost: FAUCET_HOST });
      }
    }),
  );
  saveSeeds(wallets, env, envPath);
  return wallets;
}

function saveSeeds(wallets: Wallets, env: Record<string, string>, envPath: string) {
  const merged = { ...env };
  for (const role of ROLES) merged[seedKey(role)] = wallets[role].seed!;
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(envPath, `# Testnet-only seeds created by the demo. Never put mainnet seeds here.\n${body}\n`, { mode: 0o600 });
}
