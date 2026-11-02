import { appModuleContract } from "./app-module/contract.js";
import { bpmContract } from "./bpm/contract.js";
import { bpmMigrationContract } from "./bpm-migration/contract.js";
import { bpmFlowGraphContract } from "./bpm-flow-graph/contract.js";
import { featureContract } from "./feature/contract.js";
import { featureGroupContract } from "./feature-group/contract.js";
import { menuContract } from "./menu/contract.js";
import { serialNumberContract } from "./serial-number/contract.js";
import { employeeContract } from "./employee/contract.js";
import { featureAdapter } from "./feature/adapter.js";
import { featureGroupAdapter } from "./feature-group/adapter.js";
import { serialNumberAdapter } from "./serial-number/adapter.js";
import { employeeAdapter } from "./employee/adapter.js";
import { bpmResourceHandler } from "./bpm/handler.js";
import { bpmMigrationResourceHandler } from "./bpm-migration/handler.js";
import { bpmFlowGraphResourceHandler } from "./bpm-flow-graph/handler.js";
import { menuResourceHandler } from "./menu/handler.js";
import { transContract } from "./trans/contract.js";
import { transGroupContract } from "./trans-group/contract.js";
import { transResourceHandler } from "./trans/handler.js";
import type { ResourceModule } from "../resource/modules/contracts.js";

/** The only built-in composition list that must change when a domain is added. */
export const resourceModules: readonly ResourceModule[] = [
  { contract: appModuleContract },
  { contract: featureContract, adapter: featureAdapter },
  { contract: featureGroupContract, adapter: featureGroupAdapter },
  { contract: serialNumberContract, adapter: serialNumberAdapter },
  { contract: employeeContract, adapter: employeeAdapter },
  { contract: menuContract, handler: menuResourceHandler },
  { contract: bpmContract, handler: bpmResourceHandler },
  { contract: bpmFlowGraphContract, handler: bpmFlowGraphResourceHandler },
  { contract: bpmMigrationContract, handler: bpmMigrationResourceHandler },
  { contract: transGroupContract },
  { contract: transContract, handler: transResourceHandler }
];
