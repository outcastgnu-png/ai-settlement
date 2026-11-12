// The vault and replay files are replaced by renaming a temp file over them.
// Windows refuses that rename while another process briefly holds the file
// open (seen on Christopher's PC in the Phase 4 Windows run), so it is retried.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileSync } from "../src/fs-util.js";

const fsError = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe("replaceFileSync", () => {
  it("replaces the file, and says nothing when no retry was needed", () => {
    const warned: string[] = [];
    replaceFileSync("a", "b", () => {}, () => {}, (l) => warned.push(l));
    expect(warned).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "fs-util-"));
    writeFileSync(join(dir, "f.json"), "old");
    writeFileSync(join(dir, "f.json.tmp"), "new");
    replaceFileSync(join(dir, "f.json.tmp"), join(dir, "f.json"));
    expect(readFileSync(join(dir, "f.json"), "utf8")).toBe("new");
  });

  it("tries again while Windows refuses the rename with EPERM, EACCES or EBUSY", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      let calls = 0;
      const slept: number[] = [];
      const warned: string[] = [];
      replaceFileSync("a", "b", () => { if (++calls < 3) throw fsError(code); }, (ms) => slept.push(ms), (l) => warned.push(l));
      expect(calls).toBe(3);
      expect(slept).toEqual([10, 20]);
      expect(warned).toEqual([`[fs] replaced b after 2 retries (${code})`]);
    }
  });

  it("gives up after about a second, and does not retry other errors", () => {
    let calls = 0;
    const slept: number[] = [];
    const warned: string[] = [];
    expect(() => replaceFileSync("a", "b", () => { calls++; throw fsError("EPERM"); }, (ms) => slept.push(ms), (l) => warned.push(l))).toThrow(/EPERM/);
    expect(calls).toBe(8);
    expect(warned).toEqual(["[fs] gave up replacing b after 7 retries (EPERM)"]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(1030);
    calls = 0;
    expect(() => replaceFileSync("a", "b", () => { calls++; throw fsError("ENOENT"); }, () => {}, () => {})).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });

  it("really waits between tries", () => {
    let calls = 0;
    const start = Date.now();
    replaceFileSync("a", "b", () => { if (++calls < 3) throw fsError("EBUSY"); }, undefined, () => {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
