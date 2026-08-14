import { bpmResourceHandler } from "../../bpm/resource-handler.js";
import { menuResourceHandler } from "../../menu/resource-handler.js";
import { createSpecialResourceHandlerRegistry } from "./registry.js";

export { createSpecialResourceHandlerRegistry } from "./registry.js";
export type {
  SpecialResourceHandler,
  SpecialResourceHandlerEntry,
  SpecialResourceHandlerRegistry
} from "./contracts.js";

export const specialResourceHandlerRegistry = createSpecialResourceHandlerRegistry([
  ["bpm", bpmResourceHandler],
  ["menu", menuResourceHandler]
]);
