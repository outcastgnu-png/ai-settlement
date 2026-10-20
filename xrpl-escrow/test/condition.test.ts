import { describe, expect, it } from "vitest";
// @ts-expect-error five-bells-condition ships no types
import cc from "five-bells-condition";
import { makeSecret, toCondition, toFulfillment } from "../src/condition.js";
import { JobOracle, sha256Hex } from "../src/oracle.js";

const ZERO = Buffer.alloc(32);

describe("PREIMAGE-SHA-256 encoding", () => {
  it("matches a known vector for a 32-byte zero secret", () => {
    // sha256(32 zero bytes) = 66687AAD...0D5F2925
    expect(toCondition(ZERO)).toBe(
      "A0258020" + "66687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925" + "810120",
    );
    expect(toFulfillment(ZERO)).toBe("A0228020" + "00".repeat(32));
  });

  it("agrees with the five-bells-condition reference library", () => {
    for (let i = 0; i < 20; i++) {
      const secret = makeSecret();
      const ref = new cc.PreimageSha256();
      ref.setPreimage(secret);
      expect(toCondition(secret)).toBe(ref.getConditionBinary().toString("hex").toUpperCase());
      expect(toFulfillment(secret)).toBe(ref.serializeBinary().toString("hex").toUpperCase());
      // The reference validator accepts our fulfillment for our condition.
      expect(cc.validateFulfillment(cc.Fulfillment.fromBinary(Buffer.from(toFulfillment(secret), "hex")).serializeUri(),
        cc.Condition.fromBinary(Buffer.from(toCondition(secret), "hex")).serializeUri())).toBe(true);
    }
  });

  it("rejects secrets that are not 32 bytes", () => {
    expect(() => toCondition(Buffer.alloc(31))).toThrow();
    expect(() => toFulfillment(Buffer.alloc(33))).toThrow();
  });

  it("produces uppercase hex of the expected sizes", () => {
    const s = makeSecret();
    expect(toCondition(s)).toMatch(/^[0-9A-F]{78}$/);
    expect(toFulfillment(s)).toMatch(/^[0-9A-F]{72}$/);
  });
});

describe("JobOracle", () => {
  const work = "deliverable";

  it("releases a fulfillment that opens its own condition when the hash matches", () => {
    const oracle = new JobOracle();
    const f = oracle.verify(work, sha256Hex(work));
    expect(f).not.toBeNull();
    const cond = cc.Fulfillment.fromBinary(Buffer.from(f!, "hex")).getConditionBinary().toString("hex").toUpperCase();
    expect(cond).toBe(oracle.condition);
  });

  it("returns null when the hash does not match", () => {
    expect(new JobOracle().verify("other", sha256Hex(work))).toBeNull();
  });

  it("uses a fresh secret per job", () => {
    expect(new JobOracle().condition).not.toBe(new JobOracle().condition);
  });
});
