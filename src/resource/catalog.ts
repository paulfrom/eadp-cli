import { resourceDefinitions } from "./definitions/index.js";
import {
  type ResourceContract,
  createResourceRegistry,
  type ResourceRegistry
} from "./core/contracts.js";
import { resourceAdapterRegistry } from "./adapters/index.js";
import { specialResourceHandlerRegistry } from "./handlers/index.js";

/**
 * Composition root for built-in resource contracts, adapters, and special
 * handlers. Adding an ordinary resource only requires a definition here; its
 * adapter and handler are independently registered in their own registries.
 */
export const resourceContracts: readonly ResourceContract[] = resourceDefinitions;

export const resourceRegistry: ResourceRegistry = createResourceRegistry(resourceContracts);

export { resourceAdapterRegistry, specialResourceHandlerRegistry };

export function getResourceContract(name: string): ResourceContract {
  return resourceRegistry.get(name);
}

export function listResourceContracts(): ResourceContract[] {
  return resourceRegistry.list();
}
