export { WorkbenchDatabase, defaultDataDirectory, createIsolatedTestDatabase } from './storage.js';
export type { DatabaseOptions } from './storage.js';
export { applyMigrations } from './migrate.js';
export { BASE_MIGRATIONS, EXPECTED_TABLES, verifySchema } from './schema.js';
export {
  RequirementRepository, RequirementValidationError, RequirementConflictError, RequirementNotFoundError,
  REQUIREMENT_STATUSES, REQUIREMENT_PRIORITIES,
} from './requirements.js';
export type {
  Requirement, RequirementVersion, RequirementContent, RequirementAcceptanceCriterion,
  RequirementStatus, RequirementPriority, NewRequirement,
} from './requirements.js';
export { ProjectRepository, PROJECT_TAG_LIMIT } from './projects.js';
export type { Project, NewProject, ProjectTagKind, ProjectTags } from './projects.js';
export { diffRequirementVersions, canonicalJson, diffSha256 } from './requirement-diff.js';
export type {
  DiffSnapshot, DiffOp, NeedsReviewReason, RequirementDiff, RequirementDiffChange, RequirementDiffSummary,
  AddedChange, DeletedChange, ModifiedChange, NeedsReviewChange,
} from './requirement-diff.js';
export { RequirementDiffRepository } from './requirement-diffs.js';
export type { RequirementDiffRecord, StoredRequirementDiff } from './requirement-diffs.js';
