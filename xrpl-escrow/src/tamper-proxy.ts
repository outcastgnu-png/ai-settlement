// For demos and tests only (EDR-016): a local stand-in for a registry that lies
// about a job's spec. It forwards every request to the real registry on
// 127.0.0.1 and passes every answer back unchanged, except that a job's spec in
// GET /jobs/:id is replaced by `tamper(spec)`. An oracle pointed at it is "given
// a different spec": an honest oracle compares that spec with the hash locked on
// the ledger and refuses the job. Nothing here is used by the kit's services.
import { createServer, request } from "node:http";
import { listenLocal } from "./http.js";
import { isSpecV1, type JobSpecV1 } from "./job-spec.js";

export async function startSpecTamperProxy(registryUrl: string, tamper: (spec: JobSpecV1) => JobSpecV1, port = 0) {
  const target = new URL(registryUrl);
  if (target.hostname !== "127.0.0.1") throw new Error("the tamper proxy only forwards to a registry on 127.0.0.1");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const fwd = request({
      host: target.hostname, port: target.port, path: req.url, method: req.method,
      headers: {
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        "content-length": body.length,
      },
    }, async (up) => {
      const out: Buffer[] = [];
      for await (const c of up) out.push(c as Buffer);
      let text = Buffer.concat(out).toString("utf8");
      if (req.method === "GET" && /^\/jobs\/[^/?]+$/.test(req.url ?? "") && up.statusCode === 200) {
        const job = JSON.parse(text) as { spec: unknown };
        if (isSpecV1(job.spec)) text = JSON.stringify({ ...job, spec: tamper(job.spec) });
      }
      res.writeHead(up.statusCode ?? 502, { "content-type": "application/json" });
      res.end(text);
    });
    fwd.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "registry unreachable" }));
    });
    fwd.end(body);
  });
  const bound = await listenLocal(server, port);
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}
