// Signed job spec (EDR-016) with a local registry and oracles and no ledger:
// signing before lock, versioning instead of editing in place, the oracle's
// check of the spec against the hash locked on the ledger, verdicts per
// criterion, and the provider SDK refusing shares from verdicts on another spec.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex, signRequest } from "../src/auth.js";
import { callJson } from "../src/http.js";
import { makeJobSpec, reviseJobSpec, signSpecHash, specHash, type JobSpecV1 } from "../src/job-spec.js";
import { EscrowKit } from "../src/sdk/index.js";
import { startSpecTamperProxy } from "../src/tamper-proxy.js";
import { kitLookupTx, ledgerMemos, markFunded, startLocal, startSharedLocal } from "./helpers.js";

const client = Wallet.generate();
const provider = Wallet.generate();
const WORK = JSON.stringify({ summary: "Summary: escrow fees on testnet", sources: ["tx1", "tx2"], findings: ["a", "b"] });

const newSpec = (over: Partial<Parameters<typeof makeJobSpec>[0]> = {}) => makeJobSpec({
  title: "fee research", client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 120,
  criteria: [
    { id: "format", statement: "A JSON report with summary, sources and findings", kind: "objective",
      checks: [{ type: "json-schema", schema: { type: "object", properties: { summary: { type: "string" }, sources: { type: "array" }, findings: { type: "array" } }, required: ["summary", "sources", "findings"] } }] },
    { id: "useful", statement: "The research is useful", kind: "subjective",
      checks: [{ type: "size-range", minBytes: 40, maxBytes: 10_000 }, { type: "contains-text", text: "Summary:" }] },
    { id: "exact", statement: "It is the file we agreed on", kind: "objective", checks: [{ type: "sha256-match", sha256: sha256Hex(WORK) }] },
  ],
  ...over,
});

describe("signed job spec: one oracle", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  let kit: EscrowKit;
  let seq = 300;
  beforeAll(async () => {
    local = await startLocal();
    kit = new EscrowKit({ registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, anchorAddress: "unused" });
  });
  afterAll(() => local.close());

  const signedJob = async (spec: JobSpecV1 = newSpec()) => {
    const job = await kit.createSignedJob(spec, client);
    return kit.signSpec(job.id, provider, specHash(spec));
  };

  it("the registry holds the spec and its hash; both parties sign it", async () => {
    const spec = newSpec();
    const created = await kit.createSignedJob(spec, client);
    expect(created).toMatchObject({ status: "draft", specHash: specHash(spec), specRevision: 1, client: client.address, priceDrops: "5000000" });
    expect(created.specSignatures?.client?.address).toBe(client.address);
    expect(created.specSignatures?.provider).toBeNull();
    const signed = await kit.signSpec(created.id, provider, specHash(spec));
    expect(signed.specSignatures?.provider?.address).toBe(provider.address);
    // Neither a third party nor a signature over another hash is taken.
    const other = Wallet.generate();
    await expect(callJson("POST", `${local.registry.url}/jobs/${created.id}/spec/signatures`, { specHash: specHash(spec), signature: signSpecHash(specHash(spec), other) })).rejects.toThrow(/only the spec's client or provider/);
    await expect(callJson("POST", `${local.registry.url}/jobs/${created.id}/spec/signatures`, { specHash: "00".repeat(32), signature: signSpecHash("00".repeat(32), provider) })).rejects.toThrow(/current spec/);
  });

  it("the SDK refuses to sign a spec other than the one the signer read", async () => {
    const spec = newSpec();
    const job = await kit.createJob({ spec });
    await expect(kit.signSpec(job.id, provider, specHash(newSpec()))).rejects.toThrow(/not the .* you agreed to; nothing signed/);
  });

  it("the SDK refuses to lock XRP with one signature missing", async () => {
    const spec = newSpec();
    const job = await kit.createSignedJob(spec, client); // client signed, provider not
    await expect(kit.fundJob(job.id, client)).rejects.toThrow(/refusing to lock XRP .* provider .* has not signed/);
    const unsignedByClient = await kit.createJob({ spec: newSpec() });
    await expect(kit.fundJob(unsignedByClient.id, client)).rejects.toThrow(/refusing to lock XRP .* client .* has not signed/);
    // With both signatures it gets as far as needing the ledger.
    await kit.signSpec(job.id, provider, specHash(spec));
    await expect(kit.fundJob(job.id, client)).rejects.toThrow(/needs an xrpl Client/);
    await expect(kit.fundJob(job.id, client, { specHash: "00".repeat(32) })).rejects.toThrow(/not the .* you agreed to/);
  });

  it("a subjective criterion without a check is refused by the registry, before any XRP moves", async () => {
    const spec = { ...newSpec(), rule: "all", criteria: [{ id: "useful", statement: "The research is useful", kind: "subjective", checks: [] }] };
    await expect(callJson("POST", `${local.registry.url}/jobs`, { client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 120, spec }))
      .rejects.toThrow(/This kit can't judge that statement/);
    await expect(kit.createJob({ spec: spec as JobSpecV1 })).rejects.toThrow(/refused before anything was sent/);
  });

  it("a signed spec is never edited in place: a change is the next revision, the old one is kept", async () => {
    const spec = newSpec();
    const job = await signedJob(spec);
    const edited = { ...spec, title: "fee research, cheaper" };
    await expect(callJson("PUT", `${local.registry.url}/jobs/${job.id}/spec`, { spec: edited, auth: signRequest(client, "revise-spec", job.id, specHash(edited)) }))
      .rejects.toThrow(/never edited in place/);
    await expect(kit.reviseSpec(job.id, { ...spec, revision: 3 }, client)).rejects.toThrow(/next revision of this spec is 2/);
    await expect(kit.reviseSpec(job.id, reviseJobSpec(spec, { title: "x" }), provider)).rejects.toThrow(/403|provider/);
    const next = reviseJobSpec(spec, { priceDrops: "4000000" });
    const revised = await kit.reviseSpec(job.id, next, client);
    expect(revised).toMatchObject({ specRevision: 2, specHash: specHash(next), priceDrops: "4000000", specSignatures: { client: null, provider: null } });
    const history = await kit.specRevisions(job.id);
    expect(history).toEqual([expect.objectContaining({ revision: 1, specHash: specHash(spec), spec })]);
    expect((history[0] as unknown as { signatures: { provider: { address: string } } }).signatures.provider.address).toBe(provider.address);
  });

  it("once funded, the spec can't change and signatures aren't taken", async () => {
    const spec = newSpec();
    const job = await signedJob(spec);
    await markFunded(local.registry.url, job.id, seq++);
    await expect(kit.reviseSpec(job.id, reviseJobSpec(spec, { title: "later" }), client)).rejects.toThrow(/locked on the ledger/);
    await expect(kit.signSpec(job.id, provider, specHash(spec))).rejects.toThrow(/funded/);
  });

  it("passes with atLeast 2 of 3 criteria, one failed; the verdict names the spec and each criterion", async () => {
    const spec = newSpec({ rule: { atLeast: 2 } });
    const job = await signedJob(spec);
    await markFunded(local.registry.url, job.id, seq++);
    const work = JSON.stringify({ summary: "Summary: different words", sources: ["tx9"], findings: ["c"] }); // not the agreed sha256
    const res = await kit.deliver(job.id, provider, work);
    expect(res.verdict).toMatchObject({
      verdict: "pass", specHash: specHash(spec), specVersion: 1, specRevision: 1, judged: "checks",
      criteria: [{ id: "format", kind: "objective", pass: true }, { id: "useful", kind: "subjective", pass: true }, { id: "exact", kind: "objective", pass: false }],
    });
    expect(res.verdict.checks.map((c) => c.criterion)).toEqual(["format", "useful", "useful", "exact"]);
    expect(res).toMatchObject({ verdictSignatureValid: true, specMatches: true, unsignedSpec: false });
    expect(res.fulfillment).toMatch(/^A0228020/);
    const entry = local.oracle.store.issued(job.id)!.entry;
    expect(entry).toMatchObject({ v: 2, specHash: specHash(spec), criteria: res.verdict.criteria });
  });

  it("the registry's spec changed after the lock: the oracle refuses and signs nothing", async () => {
    const spec = newSpec();
    const job = await signedJob(spec);
    await markFunded(local.registry.url, job.id, seq++);
    // A registry (or anyone with its database) swaps the criteria after the money is locked.
    const loose = { ...spec, rule: "all", criteria: [{ id: "any", statement: "anything", kind: "objective", checks: [{ type: "size-range", minBytes: 1, maxBytes: 999999 }] }] };
    local.registry.store.db.prepare("UPDATE jobs SET spec = ? WHERE id = ?").run(JSON.stringify(loose), job.id);
    await expect(kit.deliver(job.id, provider, "junk")).rejects.toThrow(/spec check failed: the registry's spec .* is not the spec locked on the ledger/);
    expect(local.oracle.store.issued(job.id)).toBeNull();
  });

  it("an escrow memo whose hash differs from the spec the oracle holds is refused", async () => {
    const spec = newSpec();
    const job = await signedJob(spec);
    await markFunded(local.registry.url, job.id, seq++);
    ledgerMemos.set(job.id, { specHash: "ab".repeat(32), specVersion: 1, revision: 1 });
    await expect(kit.deliver(job.id, provider, WORK)).rejects.toThrow(/not the spec locked on the ledger/);
    ledgerMemos.delete(job.id);
    await expect(kit.requestVerification(job.id, provider)).rejects.toThrow(/no job spec memo/);
  });

  it("a job with the older unsigned spec still runs, marked unsigned", async () => {
    const job = await kit.createJob({ client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60, spec: { checks: [{ type: "sha256-match", sha256: sha256Hex(WORK) }] } });
    expect(job).toMatchObject({ specHash: null, specSignatures: null });
    await markFunded(local.registry.url, job.id, seq++);
    const res = await kit.deliver(job.id, provider, WORK);
    expect(res.verdict).toMatchObject({ verdict: "pass", specHash: null, criteria: null, judged: "checks" });
    expect(res).toMatchObject({ unsignedSpec: true, specMatches: true, verdictSignatureValid: true });
  });
});

describe("signed job spec: a shared job, 2 of 3 oracles", () => {
  let local: Awaited<ReturnType<typeof startSharedLocal>>;
  let kit: EscrowKit;
  let seq = 400;
  let proxy: Awaited<ReturnType<typeof startSpecTamperProxy>> | null = null;
  beforeAll(async () => {
    local = await startSharedLocal(3);
    kit = new EscrowKit({ registryUrl: local.registry.url, oracleAddress: "unused", anchorAddress: "unused", statusTimeoutMs: 300, listAnchors: local.kitAnchors, lookupTx: kitLookupTx });
  });
  afterAll(async () => {
    await proxy?.close();
    await local.close();
  });

  const fundedSharedJob = async (spec: JobSpecV1) => {
    const job = await kit.createSharedJob({ spec, oracles: local.set(), threshold: 2 }, client);
    await kit.signSpec(job.id, provider, specHash(spec));
    await markFunded(local.registry.url, job.id, seq++);
    return job;
  };
  const loosen = (s: JobSpecV1): JobSpecV1 => ({ ...s, criteria: [{ id: "any", statement: "anything", kind: "objective", checks: [{ type: "size-range", minBytes: 1, maxBytes: 999999 }] }], rule: "all" });

  it("one oracle is given a different spec: it refuses, the other two still release", async () => {
    proxy = await startSpecTamperProxy(local.registry.url, loosen);
    local.oracles[2].registryUrl = proxy.url;
    await local.restart(2);
    const spec = newSpec();
    const job = await fundedSharedJob(spec);
    const res = await kit.deliverShared(job.id, provider, WORK);
    expect(res.passed).toEqual([local.oracles[0].verdictKey.address, local.oracles[1].verdictKey.address]);
    expect(res.refused).toEqual([local.oracles[2].verdictKey.address]);
    expect(res.reports[2].problems.join()).toMatch(/not the spec locked on the ledger/);
    expect(res.fulfillment).toMatch(/^A0228020/);
    expect(res.specHash).toBe(specHash(spec));
    // Each used verdict's spec hash was compared with the memo on the job's EscrowCreate.
    expect(res.reports[0].log?.specOnLedger).toBe(true);
    // A copy of the ledger whose EscrowCreate names another spec: the verdict log check fails.
    const fresh = await kit.getJob(job.id);
    const { ledgerTxs } = await import("./helpers.js");
    const real = ledgerTxs.get(fresh.createTx!)!;
    const other = makeJobSpec({ ...spec, criteria: spec.criteria });
    ledgerTxs.set(fresh.createTx!, { ...real, tx: { ...(real as { tx: Record<string, unknown> }).tx, Memos: (await import("../src/job-spec.js")).specMemos(other) } } as never);
    const lone = new EscrowKit({ registryUrl: local.registry.url, oracleUrl: local.set()[0].url, oracleAddress: local.set()[0].address, anchorAddress: local.set()[0].anchor, listAnchors: local.kitAnchors, lookupTx: kitLookupTx });
    const check = await lone.verifyVerdictLog({ verdict: res.reports[0].verdict, job: fresh, allowUnanchored: true, requireAnchor: false });
    expect(check.specOnLedger).toBe(false);
    expect(check.problems.join()).toMatch(/escrow was locked against spec/);
    ledgerTxs.set(fresh.createTx!, real);
  });

  it("an oracle that signs a verdict on another spec hash is reported, and its share is never combined", async () => {
    // This oracle skips the ledger check (a broken or dishonest oracle) and judges the swapped spec.
    local.oracles[2].specCheck = async () => null;
    await local.restart(2);
    local.oracles[1].registryUrl = proxy!.url;
    local.oracles[1].specCheck = async () => null;
    await local.restart(1);
    const spec = newSpec();
    const job = await fundedSharedJob(spec);
    const res = await kit.deliverShared(job.id, provider, "short junk"); // fails the real spec, passes the swapped one
    expect(res.rejected).toEqual([local.oracles[1].verdictKey.address, local.oracles[2].verdictKey.address]);
    for (const i of [1, 2]) expect(res.reports[i].problems.join()).toMatch(/judged spec .*, not the job's signed spec .*; its share is never combined/);
    expect(res.reports[1].verdict?.verdict).toBe("pass");
    expect(res.fulfillment).toBeNull();
    // The registry doesn't count them either.
    const verdict = res.reports[1].verdict!;
    await expect(callJson("POST", `${local.registry.url}/jobs/${job.id}/verdicts`, { verdict })).rejects.toThrow(/judged spec .*, not this job's spec/);
  });

  it("splits list the criterion the set split on", async () => {
    for (const i of [1, 2]) {
      local.oracles[i].registryUrl = local.registry.url;
      local.oracles[i].specCheck = (await import("./helpers.js")).memoSpecCheck;
      await local.restart(i, i === 2 ? "fail" : undefined);
    }
    // Oracle C runs as a dissenting oracle: it fails every job, but its per-criterion results are honest.
    const spec = newSpec({ rule: { atLeast: 2 } });
    const job = await fundedSharedJob(spec);
    const res = await kit.deliverShared(job.id, provider, WORK);
    expect(res.passed).toHaveLength(2);
    expect(res.failed).toEqual([local.oracles[2].verdictKey.address]);
    const split = (await kit.splitJobs()).find((s) => s.jobId === job.id)!;
    expect(split).toMatchObject({ specHash: specHash(spec), criteria: [] });
  });
});
