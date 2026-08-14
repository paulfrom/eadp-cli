import type { SpecialResourceHandler } from "../../resource/handlers/contracts.js";
import { bpmPhaseHooks } from "./sync.js";

export const bpmResourceHandler: SpecialResourceHandler = {
  hooks: bpmPhaseHooks
};
