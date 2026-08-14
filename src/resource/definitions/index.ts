import { appModuleContract } from "./app-module.js";
import { featureGroupContract } from "./feature-group.js";
import { featureContract } from "./feature.js";
import { serialNumberContract } from "./serial-number.js";
import { menuContract } from "./menu.js";
import { bpmContract } from "./bpm.js";
import type { ResourceContract } from "../core/contracts.js";

export { appModuleContract } from "./app-module.js";
export { featureGroupContract } from "./feature-group.js";
export { featureContract } from "./feature.js";
export { serialNumberContract } from "./serial-number.js";
export { menuContract } from "./menu.js";
export { bpmContract } from "./bpm.js";

export const resourceDefinitions: readonly ResourceContract[] = [
  appModuleContract,
  featureGroupContract,
  featureContract,
  serialNumberContract,
  menuContract,
  bpmContract
];
