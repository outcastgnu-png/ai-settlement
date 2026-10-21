// Minimal JSON-over-HTTP helpers on node:http, shared by the registry and the
// oracle. Servers only ever bind to 127.0.0.1.
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LOCALHOST } from "./local-config.js";

const MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Route {
  method: "GET" | "POST" | "PUT";
  path: string; // e.g. "/jobs/:id"
  handler: (params: Record<string, string>, body: unknown, query: URLSearchParams, headers: IncomingHttpHeaders) => unknown | Promise<unknown>;
}

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export function jsonServer(routes: Route[]): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", `http://${LOCALHOST}`);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = match(route.path, url.pathname);
        if (!params) continue;
        const result = await route.handler(params, await readJson(req), url.searchParams, req.headers);
        return send(200, result ?? {});
      }
      send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      send(500, { error: "internal error" });
      console.error(err);
    }
  });
}

/** Listen on 127.0.0.1 only. Port 0 picks a free port. */
export function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, LOCALHOST, () => resolvePort((server.address() as AddressInfo).port));
  });
}

// A private agent so localhost calls never go through an HTTP proxy configured in the environment.
const directAgent = new Agent();

/** Call a local JSON service. Throws HttpError on a non-2xx response. `token` is sent as a bearer token. */
export function callJson<T>(method: string, url: string, body?: unknown, token?: string): Promise<T> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolveCall, reject) => {
    const req = request(url, {
      method,
      agent: directAgent,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, async (res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed = text ? JSON.parse(text) : undefined;
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) reject(new HttpError(status, parsed?.error ?? `HTTP ${status}`));
      else resolveCall(parsed as T);
    });
    req.on("error", reject);
    req.end(payload);
  });
}
