import type { SpecialResourceHandler } from "../../resource/handlers/contracts.js";
import { bpmFlowGraphPhaseHooks, sanitizeBpmFlowGraphOutput } from "./service.js";

export const bpmFlowGraphResourceHandler: SpecialResourceHandler = {
  hooks: bpmFlowGraphPhaseHooks,
  sanitizeOutput: sanitizeBpmFlowGraphOutput
};
