// Start and stop the local services as child processes, the same way
// `npm run registry|oracle|watcher` would. Works on Windows: it runs Node with
// the tsx loader directly, no shell scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { callJson } from "./http.js";
import { sleep } from "./escrow.js";

export interface Service {
  name: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

export interface StartOptions {
  name: string;
  script: string; // e.g. src/oracle/server.ts
  env?: Record<string, string>;
  /** Ready when this URL answers, or when a line of output matches `readyLine`. */
  healthUrl?: string;
  readyLine?: RegExp;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export async function startService(opts: StartOptions): Promise<Service> {
  const child = spawn(process.execPath, ["--import", "tsx", opts.script], {
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.log ?? ((line: string) => console.log(line));
  let sawReadyLine = false;
  let exited = false;
  const exitPromise = new Promise<void>((done) => child.once("exit", () => ((exited = true), done())));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream! }).on("line", (line) => {
      if (opts.readyLine?.test(line)) sawReadyLine = true;
      log(`    | ${line}`);
    });
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (exited) throw new Error(`${opts.name} exited during startup`);
    if (opts.readyLine && sawReadyLine) break;
    if (opts.healthUrl) {
      try {
        await callJson("GET", opts.healthUrl);
        break;
      } catch {
        // not up yet
      }
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${opts.name} did not become ready`);
    }
    await sleep(200);
  }

  return {
    name: opts.name,
    child,
    stop: async () => {
      if (!exited) child.kill("SIGTERM");
      await exitPromise;
    },
  };
}
