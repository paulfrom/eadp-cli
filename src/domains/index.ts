import { appModuleContract } from "./app-module/contract.js";
import { bpmContract } from "./bpm/contract.js";
import { featureContract } from "./feature/contract.js";
import { featureGroupContract } from "./feature-group/contract.js";
import { menuContract } from "./menu/contract.js";
import { serialNumberContract } from "./serial-number/contract.js";
import { featureAdapter } from "./feature/adapter.js";
import { featureGroupAdapter } from "./feature-group/adapter.js";
import { serialNumberAdapter } from "./serial-number/adapter.js";
import { bpmResourceHandler } from "./bpm/handler.js";
import { menuResourceHandler } from "./menu/handler.js";
import type { ResourceModule } from "../resource/modules/contracts.js";

/** The only built-in composition list that must change when a domain is added. */
export const resourceModules: readonly ResourceModule[] = [
  { contract: appModuleContract },
  { contract: featureContract, adapter: featureAdapter },
  { contract: featureGroupContract, adapter: featureGroupAdapter },
  { contract: serialNumberContract, adapter: serialNumberAdapter },
  { contract: menuContract, handler: menuResourceHandler },
  { contract: bpmContract, handler: bpmResourceHandler }
];
