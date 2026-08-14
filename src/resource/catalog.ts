import type { ResourceContract } from "./core/contracts.js";
import { createResourceModuleCatalog } from "./modules/contracts.js";
import { resourceModules } from "../domains/index.js";

/** Single composition root for API contracts and optional behavior extensions. */
const catalog = createResourceModuleCatalog(resourceModules);

export const resourceRegistry = catalog.registry;
export const resourceContracts: readonly ResourceContract[] = resourceRegistry.contracts;
export const resourceAdapterRegistry = catalog.adapterRegistry;
export const specialResourceHandlerRegistry = catalog.handlerRegistry;
export const resourcePhaseHooksRegistry = catalog.phaseHooksRegistry;

export function getResourceContract(name: string): ResourceContract {
  return resourceRegistry.get(name);
}

export function listResourceContracts(): ResourceContract[] {
  return resourceRegistry.list();
}
