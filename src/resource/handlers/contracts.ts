import type { ResolvedEnvironment } from "../../config/resolve.js";
import type { ResourceFilter, ResourceRecord } from "../core/client.js";
import type { ResourceQueryResult } from "../core/engine.js";
import type { RuntimeOptions } from "../../runtime-options.js";

export interface SpecialResourceHandler {
  query?(options: {
    environment: ResolvedEnvironment;
    runtime: RuntimeOptions;
    filters: ResourceFilter[];
    quick?: string;
  }): Promise<ResourceQueryResult>;
  compare?(options: {
    source: ResolvedEnvironment;
    target: ResolvedEnvironment;
    runtime: RuntimeOptions;
    selectors: Readonly<Record<string, string>>;
    apply: boolean;
  }): Promise<Record<string, unknown>>;
  sync?(options: {
    source: ResolvedEnvironment;
    target: ResolvedEnvironment;
    operationStoreDirectory: string;
    runtime: RuntimeOptions;
    selectors: Readonly<Record<string, string>>;
    apply: boolean;
  }): Promise<Record<string, unknown>>;
}

export type SpecialResourceHandlerEntry = readonly [string, SpecialResourceHandler];

export interface SpecialResourceHandlerRegistry {
  get(name: string): SpecialResourceHandler;
  find(name: string): SpecialResourceHandler | undefined;
  list(): string[];
}
