// The public verdict log (EDR-014): the chain rules, the oracle's log routes
// and anchoring, and the SDK's verifyVerdictLog against a stand-in ledger.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet, type Client, type ECDSA } from "xrpl";
import { canonicalJson, sha256Hex, signPayload, signRequest } from "../src/auth.js";
import { callJson, HttpError } from "../src/http.js";
import type { SignedVerdict } from "../src/oracle/server.js";
import { VerdictStore } from "../src/oracle/verdict-store.js";
import { EscrowKit, latestAnchor } from "../src/sdk/index.js";
import {
  ANCHOR_MEMO_TYPE, anchorHistoryProblems, anchorMemos, anchorProblem, checkChain, entryHash, entryMismatch, genesisEntry,
  parseAnchorMemo, sealEntry, verdictEntry, verdictHash, verdictInLog, type LogEntry, type VerdictEntryBody,
} from "../src/verdict-log.js";
import { markFunded, startLocal, tempDir } from "./helpers.js";

const key = Wallet.generate("ed25519" as ECDSA);
const provider = Wallet.generate();
const client = Wallet.generate();

const fakeVerdict = (n: number, pass = true): SignedVerdict => {
  const body = {
    jobId: `job-${n}`, verdict: pass ? "pass" as const : "fail" as const,
    checks: [{ type: "sha256-match" as const, pass, detail: `detail ${n} that quotes "the work"` }],
    evidenceHash: sha256Hex(`work ${n}`), condition: `A0258020${"AB".repeat(32)}810120`, provider: provider.address,
    oracle: key.address, publicKey: key.publicKey, issuedAt: 1_761_000_000_000 + n,
  };
  return { ...body, signature: signPayload(body, key) };
};

function chain(n: number): { entries: LogEntry[]; verdicts: SignedVerdict[] } {
  const entries = [genesisEntry(key, null, 1_761_000_000_000)];
  const verdicts: SignedVerdict[] = [];
  for (let i = 1; i <= n; i++) {
    const v = fakeVerdict(i, i % 2 === 1);
    verdicts.push(v);
    entries.push(verdictEntry(key, entries[i - 1], v, 1_761_000_000_000 + i));
  }
  return { entries, verdicts };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (x: LogEntry[]): any[] => JSON.parse(JSON.stringify(x));

describe("verdict log chain", () => {
  it("checks a good chain and reports its head", () => {
    const { entries } = chain(4);
    expect(checkChain(entries, key.address)).toEqual({
      ok: true, problem: null, head: { seq: 4, hash: entries[4].hash }, count: 5,
    });
  });

  it("fails when an entry is edited, even with its hash recomputed", () => {
    const { entries } = chain(4);
    const edited = clone(entries);
    edited[2].verdict = edited[2].verdict === "pass" ? "fail" : "pass";
    expect(checkChain(edited, key.address).problem).toMatch(/entry 2: signature does not verify/);
    // re-hashing does not help: the signature still covers the old content
    edited[2].hash = entryHash(edited[2]);
    expect(checkChain(edited, key.address).ok).toBe(false);
    // only changing the stored hash breaks the hash check
    const rehashed = clone(entries);
    rehashed[3].hash = "00".repeat(32);
    expect(checkChain(rehashed, key.address).problem).toMatch(/entry 3: hash does not match/);
  });

  it("fails when an entry is removed", () => {
    const { entries } = chain(4);
    const removed = [...entries.slice(0, 2), ...entries.slice(3)];
    expect(checkChain(removed, key.address).problem).toMatch(/entry 2: sequence number is 3, expected 2/);
  });

  it("fails when entries are reordered", () => {
    const { entries } = chain(4);
    const swapped = [entries[0], entries[1], entries[3], entries[2], entries[4]];
    expect(checkChain(swapped, key.address).problem).toMatch(/entry 2:/);
  });

  it("fails when a properly signed entry from another branch of the chain is spliced in", () => {
    const { entries } = chain(3);
    // The real key signs a fork: same sequence numbers, but it links to a different entry 1.
    const forkOne = verdictEntry(key, entries[0], fakeVerdict(8));
    const forkTwo = verdictEntry(key, forkOne, fakeVerdict(9));
    const spliced = [entries[0], entries[1], forkTwo, entries[3]];
    expect(checkChain(spliced, key.address).problem).toMatch(/entry 2: does not link to the entry before it/);
  });

  it("fails when a re-signed entry is spliced in by a different key, or the pinned address is someone else", () => {
    const { entries } = chain(3);
    const mallory = Wallet.generate("ed25519" as ECDSA);
    const forged = clone(entries);
    forged[2] = verdictEntry(mallory, entries[1], fakeVerdict(9));
    expect(checkChain(forged, key.address).problem).toMatch(/entry 2: signed by .*not the pinned oracle/);
    // the same entry claiming the real oracle address but signed by mallory's key
    const lying = clone(forged);
    lying[2].oracle = key.address;
    expect(checkChain(lying, key.address).problem).toMatch(/entry 2: signature does not verify/);
    expect(checkChain(entries, mallory.address).ok).toBe(false);
    expect(checkChain(entries, "").ok).toBe(false);
  });

  it("refuses an empty log, a genesis in the middle, and junk", () => {
    expect(checkChain([], key.address).problem).toBe("the log is empty");
    const { entries } = chain(1);
    const twoGenesis = [entries[0], genesisEntry(key, null)];
    expect(checkChain(twoGenesis, key.address).ok).toBe(false);
    expect(checkChain([null], key.address).problem).toMatch(/not an object/);
    expect(checkChain(["x"], key.address).ok).toBe(false);
  });

  it("finds a party's own verdict by the hash of the full signed verdict, not the details shown", () => {
    const { entries, verdicts } = chain(3);
    expect(verdictInLog(entries, verdicts[1])?.seq).toBe(2);
    const altered = { ...verdicts[1], issuedAt: verdicts[1].issuedAt + 1 };
    expect(verdictInLog(entries, altered)).toBeNull();
    // the log holds the outcome of each check but not its detail
    expect(JSON.stringify(entries)).not.toContain("the work");
    expect(entries[2]).toMatchObject({ checks: [{ type: "sha256-match", pass: false }] });
  });

  it("compares a log with an anchor: it must hold the anchored entry with the anchored hash", () => {
    const { entries } = chain(3);
    const anchor = { v: 1, seq: 2, hash: entries[2].hash, oracle: key.address };
    expect(anchorProblem(entries, anchor, key.address)).toBeNull();
    expect(anchorProblem(entries, { ...anchor, hash: "11".repeat(32) }, key.address)).toMatch(/the ledger anchored/);
    expect(anchorProblem(entries.slice(0, 2), anchor, key.address)).toMatch(/has only 2 entries/);
    expect(anchorProblem(entries, { ...anchor, oracle: client.address }, key.address)).toMatch(/names oracle/);
    // Gpno N27: junk at the anchored index is a problem, not a crash.
    expect(anchorProblem([null], { ...anchor, seq: 0 }, key.address)).toMatch(/missing or not an object/);
    expect(anchorProblem([entries[0], "x"], { ...anchor, seq: 1 }, key.address)).toMatch(/missing or not an object/);
    expect(anchorHistoryProblems([null], [{ ...anchor, seq: 0 }], key.address)).toHaveLength(1);
    // A rewritten log that still checks on its own (re-signed by the real key) is caught by the anchor.
    const rewritten = [entries[0], entries[1], verdictEntry(key, entries[1], fakeVerdict(7))];
    expect(checkChain(rewritten, key.address).ok).toBe(true);
    expect(anchorProblem(rewritten, anchor, key.address)).toMatch(/entry 2 has hash/);
  });

  it("writes and reads anchor memos, and ignores anything that is not exactly an anchor memo", () => {
    const head = { seq: 5, hash: "ab".repeat(32) };
    const memos = anchorMemos(head, key.address);
    expect(parseAnchorMemo(memos)).toEqual({ v: 1, seq: 5, hash: head.hash, oracle: key.address });
    const hex = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();
    const withData = (data: string, type = ANCHOR_MEMO_TYPE) => [{ Memo: { MemoType: hex(type), MemoData: hex(data) } }];
    expect(parseAnchorMemo(withData(canonicalJson({ v: 1, seq: 5, hash: head.hash, oracle: key.address }), "other"))).toBeNull();
    expect(parseAnchorMemo(withData("not json"))).toBeNull();
    expect(parseAnchorMemo(withData(canonicalJson({ v: 1, seq: -1, hash: head.hash, oracle: key.address })))).toBeNull();
    expect(parseAnchorMemo(withData(canonicalJson({ v: 1, seq: 5, hash: "AB".repeat(32), oracle: key.address })))).toBeNull();
    expect(parseAnchorMemo(withData(canonicalJson({ v: 1, seq: 5, hash: head.hash, oracle: key.address, extra: 1 })))).toBeNull();
    expect(parseAnchorMemo(withData(canonicalJson({ v: 2, seq: 5, hash: head.hash, oracle: key.address })))).toBeNull();
    expect(parseAnchorMemo(undefined)).toBeNull();
    expect(parseAnchorMemo([{ Memo: { MemoType: "zz", MemoData: "00" } }])).toBeNull();
    // Gpno N28: an odd number of hex digits is not whole bytes, in the type or the data.
    const good = memos[0].Memo;
    expect(parseAnchorMemo([{ Memo: { ...good, MemoType: `${good.MemoType}0` } }])).toBeNull();
    expect(parseAnchorMemo([{ Memo: { ...good, MemoData: `${good.MemoData}0` } }])).toBeNull();
  });
});

describe("verdict store", () => {
  it("starts a new chain with a genesis entry naming the old unchained log's hash", () => {
    const dir = tempDir();
    const legacy = join(dir, "verdicts.jsonl");
    writeFileSync(legacy, '{"old":"verdict"}\n');
    const store = new VerdictStore(join(dir, "verdict-log.jsonl"), key, legacy);
    const [genesis] = store.page(0, 10);
    expect(genesis).toMatchObject({ kind: "genesis", seq: 0, legacyLog: { sha256: sha256Hex(readFileSync(legacy)), bytes: 18 } });
    expect(readFileSync(legacy, "utf8")).toBe('{"old":"verdict"}\n'); // kept as it was
    const fresh = new VerdictStore(join(dir, "other.jsonl"), key, join(dir, "missing.jsonl"));
    expect(fresh.page(0, 1)[0]).toMatchObject({ kind: "genesis", legacyLog: null });
  });

  it("reopens its own log, and refuses to start on a log that does not check", () => {
    const dir = tempDir();
    const path = join(dir, "verdict-log.jsonl");
    const store = new VerdictStore(path, key);
    store.append(fakeVerdict(1));
    store.append(fakeVerdict(2));
    const reopened = new VerdictStore(path, key);
    expect(reopened.head()).toEqual(store.head());
    expect(reopened.count).toBe(3);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${[lines[0], lines[2]].join("\n")}\n`);
    expect(() => new VerdictStore(path, key)).toThrow(/does not check .*refusing to start/);
    writeFileSync(path, `${lines[0]}\n{torn`);
    expect(() => new VerdictStore(path, key)).toThrow(/not JSON/);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(() => new VerdictStore(path, Wallet.generate("ed25519" as ECDSA))).toThrow(/not the pinned oracle/);
  });
});

/** A stand-in for the ledger's account_tx answer, newest first, as xrpl.js API v2 returns it. */
function fakeLedger(anchorAccount: string, txs: { memos: unknown; result?: string; validated?: boolean; type?: string; account?: string }[]) {
  const transactions = txs.map((t, i) => ({
    hash: `${String(i).padStart(2, "0")}${"CD".repeat(31)}`, ledger_index: 5_000 - i, validated: t.validated ?? true,
    meta: { TransactionResult: t.result ?? "tesSUCCESS" },
    tx_json: { TransactionType: t.type ?? "AccountSet", Account: t.account ?? anchorAccount, Memos: t.memos },
  }));
  return { request: async () => ({ result: { transactions } }) } as unknown as Client;
}

describe("latestAnchor reads the ledger, not the oracle", () => {
  const anchorAccount = Wallet.generate().address;
  const memo = (seq: number, hash: string, oracle = key.address) => anchorMemos({ seq, hash }, oracle);

  it("takes the newest validated, successful anchor from the pinned account for the pinned oracle", async () => {
    const h = (c: string) => c.repeat(64);
    const ledger = fakeLedger(anchorAccount, [
      { memos: memo(9, h("1")), validated: false },
      { memos: memo(8, h("2")), result: "tecFAILED_PROCESSING" },
      { memos: memo(7, h("3")), account: Wallet.generate().address },
      { memos: memo(6, h("4"), Wallet.generate().address) },
      { memos: memo(5, h("5")), type: "Payment" },
      { memos: undefined },
      { memos: memo(4, h("6")) },
      { memos: memo(3, h("7")) },
    ]);
    expect(await latestAnchor(ledger, anchorAccount, key.address)).toMatchObject({ seq: 4, hash: h("6"), ledgerIndex: 4_994 });
    expect(await latestAnchor(fakeLedger(anchorAccount, []), anchorAccount, key.address)).toBeNull();
  });
});

describe("oracle verdict log routes, anchoring and EscrowKit.verifyVerdictLog", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  let kit: EscrowKit;
  const jobs: { id: string; verdict: SignedVerdict }[] = [];

  beforeAll(async () => {
    local = await startLocal();
    kit = new EscrowKit({ registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address });
    for (const [i, work] of ["good", "bad", "good"].entries()) {
      const job = await kit.createJob({
        client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60,
        spec: { checks: [{ type: "sha256-match", sha256: sha256Hex("good") }] },
      });
      await markFunded(local.registry.url, job.id, 20 + i);
      const res = await kit.deliver(job.id, provider, work);
      jobs.push({ id: job.id, verdict: res.verdict });
    }
  });
  afterAll(() => local.close());

  it("serves the log in pages, and its head", async () => {
    const head = await callJson<{ seq: number; hash: string; count: number }>("GET", `${local.oracle.url}/verdicts/head`);
    expect(head.count).toBe(4);
    const page = await callJson<{ entries: LogEntry[]; count: number }>("GET", `${local.oracle.url}/verdicts?from=1&limit=2`);
    expect(page.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.count).toBe(4);
    const all = await kit.fetchVerdictLog();
    expect(checkChain(all, local.verdictKey.address).head).toEqual({ seq: head.seq, hash: head.hash });
    const bad = await callJson("GET", `${local.oracle.url}/verdicts?from=-1`).catch((e: HttpError) => e.status);
    expect(bad).toBe(400);
  });

  it("logs one entry per verdict: asking again returns the same signed verdict", async () => {
    const again = await kit.requestVerification(jobs[0].id, provider);
    expect(again.verdict).toEqual(jobs[0].verdict);
    expect((await kit.fetchVerdictLog()).length).toBe(4);
  });

  it("anchors a moved head once, and not again until it moves", async () => {
    const before = local.anchored.length;
    const anchor = await local.oracle.anchorNow();
    expect(anchor).toMatchObject({ seq: 3, hash: local.oracle.store.head().hash });
    expect(await local.oracle.anchorNow()).toBeNull();
    expect(local.anchored.length).toBe(before + 1);
    const listed = await callJson<{ anchors: { seq: number }[]; anchorAccount: string }>("GET", `${local.oracle.url}/verdicts/anchors`);
    expect(listed.anchors[0].seq).toBe(3);
  });

  it("verifyVerdictLog passes on the real log against a ledger that has its anchor", async () => {
    const head = local.oracle.store.head();
    const anchorAccount = Wallet.generate().address;
    const xrpl = fakeLedger(anchorAccount, [{ memos: anchorMemos({ seq: 2, hash: (await kit.fetchVerdictLog())[2].hash }, local.verdictKey.address) }]);
    const k = new EscrowKit({ xrpl, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount });
    const pinned = await k.verifyVerdictLog({ verdict: jobs[1].verdict });
    expect(pinned).toMatchObject({ ok: true, problems: [], count: 4, head, anchor: { seq: 2 }, unanchored: 1, verdictAnchored: true });
    // Gpno N30: a verdict in the tail after the newest anchor is not pinned yet, and ok says so.
    const tail = await k.verifyVerdictLog({ verdict: jobs[2].verdict });
    expect(tail).toMatchObject({ ok: false, verdictAnchored: false, verdictEntry: { jobId: jobs[2].id } });
    expect(tail.problems.join()).toMatch(/after the newest anchor/);
    expect(await k.verifyVerdictLog({ verdict: jobs[2].verdict, allowUnanchored: true })).toMatchObject({ ok: true, verdictAnchored: false });
  });

  it("verifyVerdictLog checks every anchor on the ledger, and fails on a second anchored genesis (Gpno N29)", async () => {
    const entries = await kit.fetchVerdictLog();
    const anchorAccount = Wallet.generate().address;
    const at = (seq: number, hash: string) => ({ memos: anchorMemos({ seq, hash }, local.verdictKey.address) });
    const kitOn = (rows: Parameters<typeof fakeLedger>[1]) => new EscrowKit({
      xrpl: fakeLedger(anchorAccount, rows), oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount,
    });
    const good = await kitOn([at(3, entries[3].hash), at(1, entries[1].hash), at(0, entries[0].hash)]).verifyVerdictLog();
    expect(good).toMatchObject({ ok: true, anchors: [{ seq: 3 }, { seq: 1 }, { seq: 0 }], lookbackComplete: true });
    // An older anchor of an entry that has since changed: the newest one alone would pass.
    const rewritten = await kitOn([at(3, entries[3].hash), at(2, "ab".repeat(32))]).verifyVerdictLog();
    expect(rewritten.problems.join()).toMatch(/entry 2 has hash .* the ledger anchored abab/);
    // Another chain under the same verdict key, anchored from the same account.
    const twoChains = await kitOn([at(3, entries[3].hash), at(0, "cd".repeat(32)), at(0, entries[0].hash)]).verifyVerdictLog();
    expect(twoChains.problems[0]).toMatch(/2 different genesis entries anchored/);
  });

  it("verifyVerdictLog fails when a signed entry's public fields disagree with the verdict it names (Gpno N26)", async () => {
    const entries = await kit.fetchVerdictLog();
    const failVerdict = jobs[1].verdict; // the "bad" delivery
    expect(failVerdict.verdict).toBe("fail");
    // The verdict key itself signs an entry whose public outcome is pass but whose verdictHash is the fail's.
    const { signature: _s, hash: _h, ...body1 } = entries[1] as LogEntry & VerdictEntryBody;
    const lie = sealEntry({
      ...body1, seq: 1, prev: entries[0].hash, jobId: failVerdict.jobId, verdict: "pass",
      checks: [{ type: "sha256-match", pass: true }], verdictHash: verdictHash(failVerdict),
      evidenceHash: failVerdict.evidenceHash, condition: failVerdict.condition, provider: failVerdict.provider, issuedAt: failVerdict.issuedAt,
    } as VerdictEntryBody, local.verdictKey);
    const forged = [entries[0], lie];
    expect(checkChain(forged, local.verdictKey.address).ok).toBe(true); // well-formed and signed
    expect(entryMismatch(lie, failVerdict)).toBe("verdict");
    expect(verdictInLog(forged, failVerdict)).toBeNull();
    const anchorAccount = Wallet.generate().address;
    const k = new EscrowKit({
      xrpl: fakeLedger(anchorAccount, [{ memos: anchorMemos({ seq: 1, hash: lie.hash }, local.verdictKey.address) }]),
      oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount,
    });
    const res = await k.verifyVerdictLog({ entries: forged, verdict: failVerdict });
    expect(res.ok).toBe(false);
    expect(res.problems.join()).toMatch(/entry 1 names this verdict but its verdict differs/);
  });

  it("verifyVerdictLog fails when the anchor on the ledger doesn't match, when there is none, or when a verdict is missing", async () => {
    const anchorAccount = Wallet.generate().address;
    const wrong = fakeLedger(anchorAccount, [{ memos: anchorMemos({ seq: 2, hash: "ee".repeat(32) }, local.verdictKey.address) }]);
    const k = new EscrowKit({ xrpl: wrong, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount });
    expect((await k.verifyVerdictLog()).problems.join()).toMatch(/entry 2 has hash .* the ledger anchored/);
    const ahead = fakeLedger(anchorAccount, [{ memos: anchorMemos({ seq: 9, hash: "ee".repeat(32) }, local.verdictKey.address) }]);
    const k2 = new EscrowKit({ xrpl: ahead, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount });
    expect((await k2.verifyVerdictLog()).problems.join()).toMatch(/covers entry 9, but the log has only 4/);
    const none = new EscrowKit({
      xrpl: fakeLedger(anchorAccount, []), oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount,
    });
    expect((await none.verifyVerdictLog()).problems.join()).toMatch(/no anchor/);
    expect((await none.verifyVerdictLog({ requireAnchor: false })).ok).toBe(true);
    const missing = await none.verifyVerdictLog({ requireAnchor: false, verdict: { ...jobs[0].verdict, issuedAt: 1 } });
    expect(missing.problems.join()).toMatch(/is not in the log/);
  });

  it("verifyVerdictLog fails on a log copy with an edited, removed or reordered entry, or the wrong pinned oracle", async () => {
    const entries = await kit.fetchVerdictLog();
    const anchorAccount = Wallet.generate().address;
    const xrpl = fakeLedger(anchorAccount, [{ memos: anchorMemos({ seq: 3, hash: entries[3].hash }, local.verdictKey.address) }]);
    const k = new EscrowKit({ xrpl, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: anchorAccount });
    expect((await k.verifyVerdictLog({ entries })).ok).toBe(true);
    const edited = clone(entries);
    edited[1].verdict = "fail";
    expect((await k.verifyVerdictLog({ entries: edited })).problems[0]).toMatch(/entry 1: signature/);
    expect((await k.verifyVerdictLog({ entries: [entries[0], entries[2], entries[3]] })).ok).toBe(false);
    expect((await k.verifyVerdictLog({ entries: [entries[0], entries[2], entries[1], entries[3]] })).ok).toBe(false);
    const stranger = new EscrowKit({ xrpl, oracleUrl: local.oracle.url, oracleAddress: Wallet.generate().address, anchorAddress: anchorAccount });
    expect((await stranger.verifyVerdictLog()).ok).toBe(false);
  });

  it("anchors on shutdown, and a restarted oracle continues the same chain", async () => {
    const job = await kit.createJob({
      client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60,
      spec: { checks: [{ type: "sha256-match", sha256: sha256Hex("good") }] },
    });
    await markFunded(local.registry.url, job.id, 30);
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, {
      content: "good", auth: signRequest(provider, "deliver", job.id, sha256Hex("good")),
    });
    await kit.requestVerification(job.id, provider);
    const head = local.oracle.store.head();
    const anchoredBefore = local.anchored.length;
    await local.restartOracle(); // close() anchors once more
    expect(local.anchored.slice(anchoredBefore)).toEqual([head]);
    expect(local.oracle.store.head()).toEqual(head);
    const after = new EscrowKit({ oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address });
    expect(checkChain(await after.fetchVerdictLog(), local.verdictKey.address).ok).toBe(true);
  });
});
