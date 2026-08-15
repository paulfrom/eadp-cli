import type { ResourceRecord } from "./client.js";
import type { BlockingIssue, MissingDependency } from "./errors.js";

export type ResourcePlanAction = "create" | "update" | "delete" | "unchanged" | "blocked";

/** Stable marker shared by ordinary resources and behavior extensions. */
export const RESOURCE_CHANGE_SET_KIND = "eadp.resource.change-set.v1" as const;

export interface ResourcePlanChange {
  key: string;
  action: ResourcePlanAction;
  changedFields: string[];
  before: ResourceRecord | null;
  desired: ResourceRecord | null;
  /** True when this record exists only on the target side. */
  targetOnly?: boolean;
  /** Optional domain labels/IDs for aggregate behavior extensions. */
  resource?: string;
  id?: string | null;
  missingDependencies?: MissingDependency[];
  blockingIssues?: BlockingIssue[];
}

export interface ResourcePlan {
  /** Versioned output marker.  Every compare/sync planner uses this shape. */
  kind: typeof RESOURCE_CHANGE_SET_KIND;
  /** Explicit alias for consumers that need to distinguish output schemas. */
  changeSetKind: typeof RESOURCE_CHANGE_SET_KIND;
  resource: string;
  sourceEnvironment?: string;
  targetEnvironment?: string;
  changes: ResourcePlanChange[];
  /** Base actions plus any aggregate extension counts (e.g. relationsAdded). */
  summary: Record<string, number>;
  missingDependencies: MissingDependency[];
  blockingIssues: BlockingIssue[];
  /** Domain metadata attached to the envelope by an aggregate behavior extension. */
  details?: Record<string, unknown>;
  /** True when an aggregate apply performs work beyond the writable records (e.g. relations). */
  appliedExtra?: boolean;
}

/** Domain-neutral name for the plan returned by compare and sync. */
export type ResourceChangeSet = ResourcePlan;
export type ResourceChange = ResourcePlanChange;

/** Single source of truth for the five-action summary of a change set. */
export function summarizeChanges(changes: ResourcePlanChange[]): Record<ResourcePlanAction, number> {
  const summary: Record<ResourcePlanAction, number> = {
    create: 0,
    update: 0,
    delete: 0,
    unchanged: 0,
    blocked: 0
  };
  for (const change of changes) summary[change.action] += 1;
  return summary;
}

/**
 * The single safety gate shared by write and sync. `blocked` changes are
 * intentionally absent from the returned list, so an applied plan can never
 * touch a record that failed dependency or mapping validation. Deletion is
 * safe only after the resource contract has explicitly classified it.
 */
export function writableChanges(changes: ResourcePlanChange[]): ResourcePlanChange[] {
  return changes.filter((change) =>
    change.action === "create" || change.action === "update" || change.action === "delete"
  );
}

/** Assemble the versioned change-set envelope from already-classified changes. */
export function makePlan(
  resource: string,
  changes: ResourcePlanChange[],
  environments?: { source: string; target: string },
  extra?: {
    summary?: Record<string, number>;
    details?: Record<string, unknown>;
    appliedExtra?: boolean;
  }
): ResourcePlan {
  return {
    kind: RESOURCE_CHANGE_SET_KIND,
    changeSetKind: RESOURCE_CHANGE_SET_KIND,
    resource,
    ...(environments ? { sourceEnvironment: environments.source, targetEnvironment: environments.target } : {}),
    changes,
    summary: { ...summarizeChanges(changes), ...(extra?.summary ?? {}) },
    missingDependencies: uniqueMissingDependencies(changes),
    blockingIssues: uniqueBlockingIssues(changes),
    ...(extra?.details ? { details: extra.details } : {}),
    ...(extra?.appliedExtra ? { appliedExtra: true } : {})
  };
}

export function uniqueMissingDependencies(changes: ResourcePlanChange[]): MissingDependency[] {
  const values = new Map<string, MissingDependency>();
  for (const change of changes) for (const item of change.missingDependencies ?? []) {
    values.set([item.resource, item.identityField, item.value.toLocaleLowerCase(), item.reason].join(":"), item);
  }
  return [...values.values()];
}

export function uniqueBlockingIssues(changes: ResourcePlanChange[]): BlockingIssue[] {
  const values = new Map<string, BlockingIssue>();
  for (const change of changes) for (const item of change.blockingIssues ?? []) {
    values.set(
      [item.resource, item.field, item.identityField ?? "", item.value ?? "", item.reason, item.message].join(":"),
      item
    );
  }
  return [...values.values()];
}
