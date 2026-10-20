// Network settings. This demo runs on the XRP Ledger testnet only.
import { HttpsProxyAgent } from "https-proxy-agent";
import { Client } from "xrpl";

export const TESTNET_NETWORK_ID = 1;
export const TESTNET_URLS = ["wss://s.altnet.rippletest.net:51233", "wss://testnet.xrpl-labs.com"];
export const FAUCET_HOST = "faucet.altnet.rippletest.net";
export const EXPLORER_TX = "https://testnet.xrpl.org/transactions/";

/** Ripple epoch starts 2000-01-01; CancelAfter and ledger close_time use it. */
export const RIPPLE_EPOCH_OFFSET = 946684800;
export const nowRippleTime = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;

/** Honour HTTPS_PROXY (corporate networks, sandboxes) for the WebSocket connection. */
function proxyAgent() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return proxy ? (new HttpsProxyAgent(proxy) as never) : undefined;
}

/** Abort unless the connected server reports the testnet network id. */
export async function assertTestnet(client: Client): Promise<void> {
  const info = await client.request({ command: "server_info" });
  const id = info.result.info.network_id;
  if (id !== TESTNET_NETWORK_ID) {
    await client.disconnect();
    throw new Error(`refusing to continue: network_id is ${id ?? "missing"}, expected ${TESTNET_NETWORK_ID} (testnet)`);
  }
}

/** Connect to the first reachable testnet server, then check it really is testnet. */
export async function connectTestnet(): Promise<Client> {
  let lastError: unknown;
  for (const url of TESTNET_URLS) {
    const client = new Client(url, { connectionTimeout: 10_000, agent: proxyAgent() });
    try {
      await client.connect();
    } catch (err) {
      lastError = err;
      continue;
    }
    await assertTestnet(client);
    return client;
  }
  throw new Error(`could not reach any testnet server (${TESTNET_URLS.join(", ")}): ${String(lastError)}`);
}
