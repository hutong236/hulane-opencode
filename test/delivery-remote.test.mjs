import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { verifyLiveDelivery } from "../hulane/scripts/lib/delivery-remote.mjs";

const sha = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const tagObjectSha = "c".repeat(40);
const repo = "acme/demo";
const tag = "v1.2.3";
const image = "ghcr.io/acme/demo";
const releaseUrl = "https://github.com/acme/demo/releases/tag/v1.2.3";
const metadata = {
  schema_version: 1, repository: repo, tag, commit_sha: sha, image,
  image_tags: [image + ":" + tag],
  image_digest: digest,
  workflow_run_url: "https://github.com/acme/demo/actions/runs/123",
  sbom: "generated", provenance: "generated",
};
const item = {
  ...createWorkItem({ id: "REQ-12", issue_number: 12, title: "Release", risk_level: "high", delivery_required: true }),
  status: "building", merged_sha: sha, image_tag: tag,
};

function liveFixture(overrides = {}) {
  const calls = [];
  const remote = {
    run: { status: "completed", conclusion: "success", event: "push", head_branch: tag, head_sha: sha },
    release: { tag_name: tag, html_url: releaseUrl, draft: false, prerelease: false, assets: [{ name: "delivery-metadata.json", size: 100 }] },
    tagRef: { object: { type: "tag", sha: tagObjectSha } },
    tagObject: { tag, object: { type: "commit", sha } },
    digest,
    releaseMetadata: structuredClone(metadata),
    ...overrides,
  };
  function run(command, args) {
    calls.push([command, ...args]);
    if (command === "gh" && args[0] === "api") {
      if (args[1].includes("/actions/runs/")) return JSON.stringify(remote.run);
      if (args[1].includes("/releases/tags/")) return JSON.stringify(remote.release);
      if (args[1].includes("/git/ref/tags/")) return JSON.stringify(remote.tagRef);
      if (args[1].includes("/git/tags/")) return JSON.stringify(remote.tagObject);
      throw new Error("Unexpected API: " + args[1]);
    }
    if (command === "gh" && args[0] === "release") {
      const index = args.indexOf("--dir");
      fs.writeFileSync(path.join(args[index + 1], "delivery-metadata.json"), JSON.stringify(remote.releaseMetadata));
      return "";
    }
    if (command === "docker") {
      return "Name: " + image + ":" + tag + "\nMediaType: application/vnd.oci.image.index.v1+json\nDigest: " + remote.digest;
    }
    if (command === "gh" && args[0] === "attestation") {
      const type = args[args.indexOf("--predicate-type") + 1];
      const ref = args[2];
      const proofDigest = ref.split("@sha256:")[1];
      const statement = {
        predicateType: type,
        subject: [{ name: overrides.wrongSubject ? "ghcr.io/acme/other" : image, digest: { sha256: proofDigest } }],
        predicate: { build: "GitHub Actions" },
      };
      return JSON.stringify([{ verificationResult: { statement } }]);
    }
    throw new Error("Unexpected command: " + command);
  }
  const args = {
    root: "/tmp", repository: repo, item,
    workflowMetadata: structuredClone(metadata), releaseMetadata: structuredClone(metadata),
    registryDigest: digest, releaseUrl, run,
  };
  return { run, remote, calls, args };
}

test("delivery verifier independently reads successful run, annotated GitHub tag, release asset, GHCR and two signed predicates", () => {
  const fixture = liveFixture();
  const result = verifyLiveDelivery(fixture.args);
  assert.equal(result.registry_verified, true);
  assert.equal(result.sbom_status, "verified");
  assert.equal(result.provenance_status, "verified");
  assert.match(result.sbom_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.provenance_digest, /^sha256:[0-9a-f]{64}$/);
  const attestationCalls = fixture.calls.filter(entry => entry[0] === "gh" && entry[1] === "attestation");
  assert.equal(attestationCalls.length, 2);
  assert.equal(fixture.calls.some(entry => entry[0] === "docker"), true);
  assert.equal(fixture.calls.some(entry => entry[0] === "gh" && entry[1] === "release"), true);
});

test("delivery verifier fails closed on failed Actions run or forged claimed digest", () => {
  const fail = liveFixture({ run: { status: "completed", conclusion: "failure", event: "push", head_branch: tag, head_sha: sha } });
  assert.throws(() => verifyLiveDelivery(fail.args), /did not successfully build/);
  const spoof = liveFixture();
  assert.throws(() => verifyLiveDelivery({ ...spoof.args, registryDigest: "sha256:" + "d".repeat(64) }), /GHCR registry digest mismatch/);
});

test("delivery verifier rejects tag mutation, missing release asset and false release metadata", () => {
  const mutable = liveFixture({ tagRef: { object: { type: "commit", sha } } });
  assert.throws(() => verifyLiveDelivery(mutable.args), /not an annotated tag/);
  const absent = liveFixture({ release: { tag_name: tag, html_url: releaseUrl, assets: [], draft: false } });
  assert.throws(() => verifyLiveDelivery(absent.args), /lacks delivery-metadata/);
  const changed = liveFixture({ releaseMetadata: { ...metadata, commit_sha: "e".repeat(40) } });
  assert.throws(() => verifyLiveDelivery(changed.args), /differs from the real GitHub Release asset/);
});

test("delivery verifier rejects forged signing predicate or subject and caller-supplied attestation hashes", () => {
  const wrongSubject = liveFixture({ wrongSubject: true });
  assert.throws(() => verifyLiveDelivery(wrongSubject.args), /does not bind the intended GHCR image/);
  const wrongHash = liveFixture();
  assert.throws(() => verifyLiveDelivery({ ...wrongHash.args, sbomDigest: "sha256:" + "e".repeat(64) }), /Caller attestation hash disagrees/);
});
