import { defineConfig } from "vitest/config";

// The testnet flow tests share the same wallets, so test files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });
