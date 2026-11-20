import test from "node:test";
import assert from "node:assert/strict";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { validateDeliveryEvidence } from "../hulane/scripts/lib/delivery.mjs";

const mergedSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const sbomDigest = `sha256:${"c".repeat(64)}`;
const provenanceDigest = `sha256:${"d".repeat(64)}`;
const metadata = {
  schema_version: 1,
  repository: "acme/demo",
  tag: "v1.4.0",
  commit_sha: mergedSha,
  image: "ghcr.io/acme/demo",
  image_tags: ["ghcr.io/acme/demo:v1.4.0", "ghcr.io/acme/demo:1.4.0"],
  image_digest: digest,
  workflow_run_url: "https://github.com/acme/demo/actions/runs/123",
  sbom: "generated",
  provenance: "generated",
};

function item() {
  return { ...createWorkItem({
    id: "REQ-44",
    issue_number: 44,
    title: "Delivery",
    risk_level: "low",
    delivery_required: true,
  }), merged_sha: mergedSha, image_tag: "v1.4.0" };
}

test("delivery evidence must agree across workflow, release, registry, and merged SHA", () => {
  const patch = validateDeliveryEvidence({
    item: item(),
    workflowMetadata: metadata,
    releaseMetadata: structuredClone(metadata),
    registryDigest: digest,
    releaseUrl: "https://github.com/acme/demo/releases/tag/v1.4.0",
    sbomDigest,
    provenanceDigest,
  });
  assert.equal(patch.registry_verified, true);
  assert.equal(patch.image_digest, digest);
});

test("registry digest mismatch is rejected", () => {
  assert.throws(() => validateDeliveryEvidence({
    item: item(),
    workflowMetadata: metadata,
    releaseMetadata: structuredClone(metadata),
    registryDigest: `sha256:${"c".repeat(64)}`,
    releaseUrl: "https://github.com/acme/demo/releases/tag/v1.4.0",
    sbomDigest,
    provenanceDigest,
  }), /Registry digest/);
});

test("delivery cannot substitute a different tag after Gate C", () => {
  assert.throws(() => validateDeliveryEvidence({
    item: { ...item(), image_tag: "v1.4.1" },
    workflowMetadata: metadata,
    releaseMetadata: structuredClone(metadata),
    registryDigest: digest,
    releaseUrl: "https://github.com/acme/demo/releases/tag/v1.4.0",
    sbomDigest,
    provenanceDigest,
  }), /Gate C/);
});
