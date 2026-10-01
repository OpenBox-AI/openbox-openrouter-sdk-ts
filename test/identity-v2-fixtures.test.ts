import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The v2 agent-identity golden fixtures are owned by openbox-core
// (testdata/identity-v2) and copied here by its scripts/sync-identity-fixtures.sh.
// These tests prove the fixture parses in TypeScript and that this repo computes
// byte-identical hashes, so a contract change cannot land in Go only.
//
// Do not edit files under test/fixtures/identity-v2 — CI runs the drift check.

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");

const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const POSITIVE_CASES = [
  "evaluate.json",
  "approval.json",
  "auth-validate.json",
  "handoff.json",
  "transition-proof.json"
] as const;

const REQUIRED_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "obx_deployment_id",
  "obx_organization_id",
  "obx_agent_id",
  "obx_api_key_sha256",
  "iat",
  "exp",
  "jti",
  "htm",
  "htu",
  "body_sha256"
] as const;

interface PositiveFixture {
  name: string;
  method: string;
  path: string;
  api_key: string;
  body_base64: string;
  body_sha256: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  assertion: string;
  expect: { valid: boolean };
}

interface TamperFixture {
  name: string;
  body_base64: string;
  assertion: string;
  expect: { valid: boolean; reason_code: string };
}

function readFixture<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, ...segments), "utf8")) as T;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("identity v2 golden fixtures", () => {
  it.each(POSITIVE_CASES)("%s is internally consistent", (file) => {
    const fixture = readFixture<PositiveFixture>(file);
    expect(fixture.expect.valid).toBe(true);

    const body = Buffer.from(fixture.body_base64, "base64");
    expect(sha256Hex(body)).toBe(fixture.body_sha256);
    expect(sha256Hex(Buffer.from(fixture.api_key, "utf8"))).toBe(fixture.claims.obx_api_key_sha256);

    const segments = fixture.assertion.split(".");
    expect(segments).toHaveLength(3);

    // `toHaveLength(3)` above already guarantees indices 0/1 are defined;
    // `noUncheckedIndexedAccess` still types array access as possibly
    // undefined, so assert what the runtime check already proved.
    const header = decodeSegment(segments[0]!);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("openbox-agent-proof+jwt");
    expect(header).not.toHaveProperty("jwk");
    expect(header).not.toHaveProperty("jku");
    expect(header).not.toHaveProperty("x5u");

    const claims = decodeSegment(segments[1]!);
    for (const claim of REQUIRED_CLAIMS) {
      expect(claims, `missing claim ${claim}`).toHaveProperty(claim);
    }

    expect(claims.htm).toBe(fixture.method);
    expect(claims.htu).toBe(fixture.path);
    expect(claims.body_sha256).toBe(fixture.body_sha256);
    expect(claims.iss).toBe(claims.sub);

    const lifetime = (claims.exp as number) - (claims.iat as number);
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(60);

    // A shared audience such as "openbox-core" would let a staging assertion
    // authenticate against production.
    expect(claims.aud as string).toMatch(/^urn:openbox:.+:core$/);
  });

  it("auth-validate hashes the empty body to the well-known constant", () => {
    const fixture = readFixture<PositiveFixture>("auth-validate.json");
    expect(fixture.method).toBe("GET");
    expect(fixture.body_sha256).toBe(EMPTY_BODY_SHA256);
    expect(sha256Hex(Buffer.alloc(0))).toBe(EMPTY_BODY_SHA256);
  });

  it("transition proof carries the three transition claims", () => {
    const fixture = readFixture<PositiveFixture>("transition-proof.json");
    const segments = fixture.assertion.split(".");
    expect(segments).toHaveLength(3);
    const claims = decodeSegment(segments[1]!);
    expect(claims.obx_transition_purpose).toBeTruthy();
    expect(claims.obx_transition_id).toBeTruthy();
    expect(claims.obx_transition_challenge).toBeTruthy();
  });

  it("every tamper fixture declares a failure and a reason code", () => {
    const files = readdirSync(join(FIXTURE_DIR, "tamper")).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const fixture = readFixture<TamperFixture>("tamper", file);
      expect(fixture.expect.valid, `${file} is marked valid`).toBe(false);
      expect(fixture.expect.reason_code, `${file} has no reason code`).toBeTruthy();
    }
  });

  it("matches the manifest published by openbox-core", () => {
    // Guards against a fixture edited here instead of regenerated in openbox-core.
    const manifest = readFileSync(join(FIXTURE_DIR, "MANIFEST.sha256"), "utf8");
    const recorded = new Map<string, string>();

    for (const line of manifest.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const [digest, relative] = trimmed.split(/\s+/);
      if (!digest || !relative) continue;
      recorded.set(relative, digest);
    }
    expect(recorded.size).toBeGreaterThan(0);

    const walk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`]
      );

    const onDisk = walk(FIXTURE_DIR).filter((name) => name !== "MANIFEST.sha256");

    for (const relative of onDisk) {
      const digest = sha256Hex(readFileSync(join(FIXTURE_DIR, relative)));
      expect(recorded.get(relative), `${relative} is not in the manifest`).toBeDefined();
      expect(digest, `${relative} has drifted from openbox-core`).toBe(recorded.get(relative));
    }

    for (const relative of recorded.keys()) {
      expect(onDisk, `${relative} is in the manifest but missing on disk`).toContain(relative);
    }
  });

  it("the fixture keypair is RSA-2048 and marked non-production", () => {
    const keypair = readFixture<{
      WARNING: string;
      public_jwk: { kty: string; alg: string; n: string };
      private_jwk: { d: string };
      undersized_key_for_negative_test: { public_jwk: { n: string } };
    }>("keypair.json");

    expect(keypair.WARNING).toContain("never deploy");
    expect(keypair.public_jwk.kty).toBe("RSA");
    expect(keypair.public_jwk.alg).toBe("RS256");
    expect(keypair.private_jwk.d).toBeTruthy();

    const modulusBits = Buffer.from(keypair.public_jwk.n, "base64url").length * 8;
    expect(modulusBits).toBeGreaterThanOrEqual(2048);

    const undersizedBits =
      Buffer.from(keypair.undersized_key_for_negative_test.public_jwk.n, "base64url").length * 8;
    expect(undersizedBits).toBeLessThan(2048);
  });
});
