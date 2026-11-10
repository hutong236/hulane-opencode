const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function requiredString(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function validateMetadata(metadata, source) {
  if (metadata?.schema_version !== 1) throw new Error(`${source} has unsupported schema_version`);
  if (!TAG_PATTERN.test(String(metadata.tag ?? ""))) throw new Error(`${source} has invalid SemVer tag`);
  if (!SHA_PATTERN.test(String(metadata.commit_sha ?? ""))) throw new Error(`${source} has invalid commit_sha`);
  if (!DIGEST_PATTERN.test(String(metadata.image_digest ?? ""))) throw new Error(`${source} has invalid image_digest`);
  const image = requiredString(metadata.image, `${source}.image`);
  if (!image.startsWith("ghcr.io/") || image !== image.toLowerCase()) throw new Error(`${source} image must be lowercase GHCR`);
  if (!Array.isArray(metadata.image_tags) || !metadata.image_tags.includes(`${image}:${metadata.tag}`)) {
    throw new Error(`${source} is missing the immutable release tag`);
  }
  if (metadata.sbom !== "generated" || metadata.provenance !== "generated") {
    throw new Error(`${source} is missing SBOM/provenance generation evidence`);
  }
  if (!String(metadata.workflow_run_url ?? "").startsWith("https://github.com/")) {
    throw new Error(`${source} has invalid workflow_run_url`);
  }
}

export function validateDeliveryEvidence({ item, workflowMetadata, releaseMetadata, registryDigest, releaseUrl, sbomDigest, provenanceDigest }) {
  validateMetadata(workflowMetadata, "workflow metadata");
  validateMetadata(releaseMetadata, "release metadata");
  if (!SHA_PATTERN.test(String(item.merged_sha ?? ""))) throw new Error("Work Item has no valid merged_sha");
  if (workflowMetadata.commit_sha !== item.merged_sha) throw new Error("Delivery commit does not equal merged_sha");
  if (item.image_tag && workflowMetadata.tag !== item.image_tag) throw new Error("Delivery tag does not equal the Gate C confirmation");

  for (const field of ["tag", "commit_sha", "image", "image_digest"]) {
    if (workflowMetadata[field] !== releaseMetadata[field]) throw new Error(`Release metadata mismatch: ${field}`);
  }
  if (!DIGEST_PATTERN.test(String(registryDigest ?? ""))) throw new Error("Registry returned no valid digest");
  if (registryDigest !== workflowMetadata.image_digest) throw new Error("Registry digest does not match delivery metadata");
  if (!String(releaseUrl ?? "").startsWith("https://github.com/")) throw new Error("A GitHub Release URL is required");
  if (!DIGEST_PATTERN.test(String(sbomDigest ?? ""))) throw new Error("Registry returned no valid SBOM attestation digest");
  if (!DIGEST_PATTERN.test(String(provenanceDigest ?? ""))) throw new Error("Registry returned no valid provenance attestation digest");

  return {
    image: workflowMetadata.image,
    image_tag: workflowMetadata.tag,
    image_digest: workflowMetadata.image_digest,
    workflow_run_url: workflowMetadata.workflow_run_url,
    registry_verified: true,
    release_url: releaseUrl,
    sbom_status: "verified",
    provenance_status: "verified",
    sbom_digest: sbomDigest,
    provenance_digest: provenanceDigest,
  };
}
