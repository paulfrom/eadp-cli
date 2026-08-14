import type { ResolvedEnvironment } from "../../config/resolve.js";
import type { ResourceFilter } from "../core/client.js";
import type {
  ResourcePhaseHooks,
  ResourceQueryResult
} from "../core/engine.js";
import type { RuntimeOptions } from "../../runtime-options.js";

/**
 * A special handler may provide a read-only `query` and/or `hooks` that extend
 * phases of the generic engine lifecycle. Compare/sync/write are always
 * executed by the engine; there is no whole-action handler for them.
 */
export interface SpecialResourceHandler {
  query?(options: {
    environment: ResolvedEnvironment;
    runtime: RuntimeOptions;
    filters: ResourceFilter[];
    quick?: string;
  }): Promise<ResourceQueryResult>;
  hooks?: ResourcePhaseHooks;
}

export type SpecialResourceHandlerEntry = readonly [string, SpecialResourceHandler];

export interface SpecialResourceHandlerRegistry {
  get(name: string): SpecialResourceHandler;
  find(name: string): SpecialResourceHandler | undefined;
  list(): string[];
}
