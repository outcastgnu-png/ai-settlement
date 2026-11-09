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

/**
 * Top up below this balance. The Phase 2 demo locks three 10 XRP escrows at once
 * after paying a fourth, plus their owner reserves, and every paid job moves 10 XRP
 * from the client to the provider for good, so 30 was too little once a few runs
 * had drained the client (npm test, 2026-10-21: EscrowCreate failed in scenario 3).
 */
export const MIN_BALANCE_XRP = 60;

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

/** The anchor wallet only pays AccountSet fees (about 12 drops each), so a little above the reserve is plenty. */
export const MIN_ANCHOR_BALANCE_XRP = 5;

/**
 * The oracle's anchor wallet (EDR-014): a dedicated faucet-funded testnet account
 * that puts the verdict log's head on the ledger. Its seed goes in .env as
 * ORACLE_ANCHOR_SEED and its address as ORACLE_ANCHOR_ADDRESS, which SDK users pin.
 */
export async function loadOrFundAnchor(client: Client, envPath = ".env"): Promise<Wallet> {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const seed = parse(current).ORACLE_ANCHOR_SEED;
  const wallet = seed ? Wallet.fromSeed(seed) : Wallet.generate();
  if (!seed) {
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(envPath, `${current}${sep}ORACLE_ANCHOR_SEED=${wallet.seed}\nORACLE_ANCHOR_ADDRESS=${wallet.address}\n`, { mode: 0o600 });
  }
  if ((await xrpBalance(client, wallet.address)) < MIN_ANCHOR_BALANCE_XRP) {
    await client.fundWallet(wallet, { faucetHost: FAUCET_HOST });
  }
  return wallet;
}
