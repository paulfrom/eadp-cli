import type { SpecialResourceHandler } from "../../resource/handlers/contracts.js";
import type { ResourcePhaseHooks } from "../../resource/core/engine.js";
import { sanitizeBpmFlowGraphOutput } from "../bpm-flow-graph/service.js";

/**
 * The combined resource owns no records of its own. The engine plans and
 * applies the declared dependencies (bpm, then bpm-flow-graph); these hooks
 * keep the root phase a no-op and always verified.
 */
const bpmMigrationPhaseHooks: ResourcePhaseHooks = {
  aggregatePlan: async () => ({ changes: [] }),
  apply: async () => undefined,
  verify: async () => true
};

export const bpmMigrationResourceHandler: SpecialResourceHandler = {
  hooks: bpmMigrationPhaseHooks,
  // The merged plan contains bpm-flow-graph changes; keep their graph payloads
  // out of terminal output exactly like the standalone graph resource.
  sanitizeOutput: sanitizeBpmFlowGraphOutput
};
