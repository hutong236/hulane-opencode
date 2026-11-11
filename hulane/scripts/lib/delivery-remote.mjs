import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateDeliveryEvidence } from "./delivery.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SPDX_TYPE = "https://spdx.dev/Document/v2.3";
const SLSA_TYPE = "https://slsa.dev/provenance/v1";

function systemCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", shell: false, timeout: 180000, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(command + " verification failed (exit " + (result.status ?? "spawn") + ")");
  }
  return String(result.stdout ?? "").trim();
}

function ghJson(run, args, root) {
  const result = JSON.parse(run("gh", ["api", ...args], root));
  return result;
}

function exactRunId(url, repo) {
  const match = String(url ?? "").match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)$/);
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) throw new Error("Workflow URL does not match bound repository");
  return Number(match[2]);
}
function readAttestation(run, { root, repository, imageRef, digest, predicate }) {
  const output = JSON.parse(run("gh", [
    "attestation", "verify", "oci://" + imageRef,
    "--repo", repository, "--signer-repo", repository,
    "--signer-workflow", repository + "/.github/workflows/build-image.yml",
    "--source-digest", digest, "--predicate-type", predicate, "--format", "json",
  ], root));
  if (!Array.isArray(output) || !output.length) throw new Error("Missing cryptographically verified " + predicate + " attestation");
  const verified = output.map(entry => entry.verificationResult?.statement).filter(Boolean);
  const matching = verified.find(statement =>
    statement.predicateType === predicate &&
    Array.isArray(statement.subject) &&
    statement.subject.some(subject =>
      subject.name === imageRef.split("@")[0] &&
      subject.digest?.sha256 === imageRef.split("@")[1].replace(/^sha256:/, "")
    )
  );
  if (!matching) throw new Error("Attestation does not bind the intended GHCR image digest and predicate " + predicate);
  return "sha256:" + createHash("sha256").update(JSON.stringify(matching)).digest("hex");
}

// This is the sole path that can promote untrusted metadata to image_verified.
// All authenticated and digest-bound source checks are performed again here.
export function verifyLiveDelivery({
  root, repository, item, workflowMetadata, releaseMetadata,
  registryDigest, releaseUrl, sbomDigest, provenanceDigest,
  run = systemCommand,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? ""))) {
    throw new Error("A bound owner/repository is required for delivery verification");
  }
  if (!SHA.test(String(item.merged_sha ?? ""))) throw new Error("Delivery requires recorded merged_sha");
  const tag = String(item.image_tag ?? "");
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("Delivery requires an approved SemVer tag");
  const expectedImage = "ghcr.io/" + repository.toLowerCase();
  if (workflowMetadata?.image !== expectedImage || workflowMetadata?.tag !== tag ||
      workflowMetadata?.commit_sha !== item.merged_sha) {
    throw new Error("Claimed delivery image, tag or commit differs from Work Item and repository");
  }
  if (!DIGEST.test(workflowMetadata?.image_digest ?? "")) throw new Error("Missing exact image digest");

  const runId = exactRunId(workflowMetadata.workflow_run_url, repository);
  const job = ghJson(run, [`repos/${repository}/actions/runs/${runId}`], root);
  if (job.status !== "completed" || job.conclusion !== "success" ||
      job.event !== "push" || job.head_sha !== item.merged_sha || job.head_branch !== tag) {
    throw new Error("GitHub Actions run did not successfully build the pinned tag and merged commit");
  }
  const release = ghJson(run, [`repos/${repository}/releases/tags/${tag}`], root);
  const expectedReleaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  if (release.tag_name !== tag || release.html_url !== expectedReleaseUrl || releaseUrl !== expectedReleaseUrl ||
      release.draft === true || release.prerelease === true && !tag.includes("-")) {
    throw new Error("Live GitHub Release is missing or does not match Gate C tag");
  }
  const ref = ghJson(run, [`repos/${repository}/git/ref/tags/${tag}`], root);
  if (ref.object?.type !== "tag" || !SHA.test(String(ref.object?.sha ?? ""))) {
    throw new Error("Release ref is not an annotated tag");
  }
  const tagObject = ghJson(run, [`repos/${repository}/git/tags/${ref.object.sha}`], root);
  if (tagObject.tag !== tag || tagObject.object?.type !== "commit" || tagObject.object.sha !== item.merged_sha) {
    throw new Error("Annotated release tag does not point to the verified merged SHA");
  }
  const metadataAsset = (release.assets ?? []).find(asset => asset.name === "delivery-metadata.json");
  if (!metadataAsset || !(metadataAsset.size > 0)) throw new Error("GitHub Release lacks delivery-metadata.json");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-verified-release-"));
  let actual;
  try {
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", "delivery-metadata.json", "--dir", temp], root);
    actual = JSON.parse(fs.readFileSync(path.join(temp, "delivery-metadata.json"), "utf8"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (!isDeepStrictEqual(actual, releaseMetadata) || !isDeepStrictEqual(actual, workflowMetadata)) {
    throw new Error("Claimed workflow/release metadata differs from the real GitHub Release asset");
  }

  const registryOutput = run("docker", ["buildx", "imagetools", "inspect", expectedImage + ":" + tag], root);
  const digest = String(registryOutput).match(/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m)?.[1];
  if (!digest || digest !== workflowMetadata.image_digest || digest !== registryDigest) {
    throw new Error("GHCR registry digest mismatch or registry image not reachable");
  }
  const immutableImage = expectedImage + "@" + digest;
  const verifiedProvenance = readAttestation(run, {
    root, repository, imageRef: immutableImage, digest: item.merged_sha, predicate: SLSA_TYPE,
  });
  const verifiedSbom = readAttestation(run, {
    root, repository, imageRef: immutableImage, digest: item.merged_sha, predicate: SPDX_TYPE,
  });
  if ((provenanceDigest && provenanceDigest !== verifiedProvenance) ||
      (sbomDigest && sbomDigest !== verifiedSbom)) {
    throw new Error("Caller attestation hash disagrees with cryptographically verified evidence");
  }
  // These two digests are hashes of the verified statements, NOT OCI referrer
  // digests. They are computed independently by this control-plane process.
  return validateDeliveryEvidence({
    item, workflowMetadata: actual, releaseMetadata: actual,
    registryDigest: digest, releaseUrl: expectedReleaseUrl,
    sbomDigest: verifiedSbom, provenanceDigest: verifiedProvenance,
  });
}
