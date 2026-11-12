// Replacing a file by renaming a temp file over it. On Windows the rename is
// refused (EPERM, EACCES or EBUSY) while another process, such as a virus
// scanner, the search indexer or a test reading the file, briefly has the
// target open. That is a short-lived lock, so try again for about a second
// before giving up. Other errors, and the last refusal, are thrown as they are.
// A rename that needed retries says so on stderr, so a Windows run shows how
// often it happened.
import { renameSync } from "node:fs";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
const DELAYS_MS = [10, 20, 40, 80, 160, 320, 400];

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function replaceFileSync(
  tmp: string, dest: string,
  rename: (from: string, to: string) => void = renameSync,
  sleep: (ms: number) => void = sleepSync,
  warn: (line: string) => void = (line) => console.warn(line),
): void {
  let lastCode = "";
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, dest);
      if (attempt > 0) warn(`[fs] replaced ${dest} after ${attempt} retr${attempt === 1 ? "y" : "ies"} (${lastCode})`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE.has(code)) throw err;
      if (attempt >= DELAYS_MS.length) {
        warn(`[fs] gave up replacing ${dest} after ${attempt} retries (${code})`);
        throw err;
      }
      lastCode = code;
      sleep(DELAYS_MS[attempt]);
    }
  }
}
