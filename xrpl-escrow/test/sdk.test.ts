import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex } from "../src/auth.js";
import { EscrowKit, escrowRef, verifyVerdict } from "../src/sdk/index.js";
import { markFunded, startLocal } from "./helpers.js";

const client = Wallet.generate();
const provider = Wallet.generate();
const spec = { checks: [{ type: "sha256-match" as const, sha256: sha256Hex("the work") }] };

describe("EscrowKit (registry + oracle, no ledger)", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  let kit: EscrowKit;
  beforeAll(async () => {
    local = await startLocal();
    kit = new EscrowKit({
      registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address, statusTimeoutMs: 300,
    });
  });
  afterAll(() => local.close());

  const newJob = () => kit.createJob({ client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60, spec });

  it("createJob registers a draft with the oracle's condition", async () => {
    const job = await newJob();
    expect(job.status).toBe("draft");
    expect(job.condition).toMatch(/^A0258020[0-9A-F]{64}810120$/);
    expect(() => escrowRef(job)).toThrow(/no escrow/);
  });

  it("ledger calls need an xrpl client and the right wallet", async () => {
    const job = await newJob();
    await expect(kit.fundJob(job.id, client)).rejects.toThrow(/xrpl Client/);
    await expect(kit.fundJob(job.id, provider)).rejects.toThrow(/only the job's client/);
  });

  it("deliver returns a checked, signed pass with the fulfillment", async () => {
    const job = await newJob();
    await markFunded(local.registry.url, job.id);
    const res = await kit.deliver(job.id, provider, "the work");
    expect(res.job.status).toBe("verified_pass");
    expect(res.verdict.verdict).toBe("pass");
    expect(res.verdictSignatureValid).toBe(true);
    expect(res.fulfillment).toMatch(/^A0228020[0-9A-F]{64}$/);
    expect(escrowRef(res.job)).toEqual({ owner: client.address, offerSequence: 7, condition: job.condition, cancelAfter: 900_000_000 });
  });

  it("deliver returns a signed fail with no fulfillment", async () => {
    const job = await newJob();
    await markFunded(local.registry.url, job.id, 8);
    const res = await kit.deliver(job.id, provider, "something else");
    expect(res).toMatchObject({ fulfillment: null, verdictSignatureValid: true });
    expect(res.job.status).toBe("verified_fail");
    expect(verifyVerdict(res.verdict, local.verdictKey.address)).toBe(true);
  });

  it("does not trust a verdict from an oracle address other than the pinned one", async () => {
    const other = new EscrowKit({
      registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: Wallet.generate().address,
    });
    const job = await newJob();
    await markFunded(local.registry.url, job.id, 10);
    const res = await other.deliver(job.id, provider, "the work");
    expect(res.verdict.verdict).toBe("pass");
    expect(res.verdictSignatureValid).toBe(false);
  });

  it("deliver is refused for a non-provider and before funding", async () => {
    const job = await newJob();
    await expect(kit.deliver(job.id, provider, "the work")).rejects.toThrow(/only when funded/);
    await markFunded(local.registry.url, job.id, 9);
    await expect(kit.deliver(job.id, client, "the work")).rejects.toThrow(/provider/);
  });

  it("waitForStatus times out with the current status", async () => {
    const job = await newJob();
    await expect(kit.waitForStatus(job.id, ["paid"], 100)).rejects.toThrow(/is draft/);
  });

  it("reports provider reputation", async () => {
    const rep = await kit.reputation(provider.address);
    expect(rep).toMatchObject({ provider: provider.address, passed: 2, failed: 1 });
    expect(rep.total).toBeGreaterThanOrEqual(5);
  });
});
