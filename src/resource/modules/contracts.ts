import { CliError } from "../../errors.js";
import {
  createResourceRegistry,
  type ResourceContract,
  type ResourceRegistry
} from "../core/contracts.js";
import {
  createResourceAdapterRegistry,
  createResourcePhaseHooksRegistry,
  type ResourceAdapter,
  type ResourceAdapterRegistry,
  type ResourcePhaseHooks,
  type ResourcePhaseHooksRegistry
} from "../core/engine.js";
import { createSpecialResourceHandlerRegistry } from "../handlers/registry.js";
import type {
  SpecialResourceHandler,
  SpecialResourceHandlerRegistry
} from "../handlers/contracts.js";

/**
 * One composition unit per resource domain. The contract is sufficient for an
 * ordinary API-backed resource; adapter/handler code is attached only when the
 * declared API semantics cannot express dependency mapping or aggregate I/O.
 */
export interface ResourceModule {
  contract: ResourceContract;
  adapter?: ResourceAdapter;
  handler?: SpecialResourceHandler;
}

export interface ResourceModuleCatalog {
  registry: ResourceRegistry;
  adapterRegistry: ResourceAdapterRegistry;
  handlerRegistry: SpecialResourceHandlerRegistry;
  phaseHooksRegistry: ResourcePhaseHooksRegistry;
}

/** Compose and validate every resource extension before any CLI action runs. */
export function createResourceModuleCatalog(
  modules: readonly ResourceModule[]
): ResourceModuleCatalog {
  const registry = createResourceRegistry(modules.map((module) => module.contract));
  const adapters = new Map<string, ResourceAdapter>();
  const handlers = new Map<string, SpecialResourceHandler>();
  const phaseHooks = new Map<string, ResourcePhaseHooks>();

  for (const module of modules) {
    const { contract } = module;
    assertExtensionPair(contract, "adapter", module.adapter);
    assertExtensionPair(contract, "handler", module.handler);
    if (contract.adapter && module.adapter) {
      registerUnique(adapters, contract.adapter, module.adapter, "适配器");
    }
    if (contract.handler && module.handler) {
      registerUnique(handlers, contract.handler, module.handler, "特殊处理器");
      if (module.handler.hooks) {
        registerUnique(phaseHooks, contract.id, module.handler.hooks, "阶段钩子");
        assertHooksCapabilities(contract, module.handler, module.handler.hooks);
      } else {
        for (const capability of contract.capabilities) {
          if (capability !== "query") {
            throw new CliError(`资源 ${contract.id} 的 ${capability} 能力必须经由通用引擎（提供阶段钩子）`);
          }
          if (typeof module.handler.query !== "function") {
            throw new CliError(`资源 ${contract.id} 声明 query 能力但未提供查询处理器`);
          }
        }
      }
    }
  }

  return {
    registry,
    adapterRegistry: createResourceAdapterRegistry([...adapters.entries()]),
    handlerRegistry: createSpecialResourceHandlerRegistry([...handlers.entries()]),
    phaseHooksRegistry: createResourcePhaseHooksRegistry([...phaseHooks.entries()])
  };
}

/**
 * Validate the phase coverage of a hooks handler. `query` remains the only
 * read-only handler method; compare/sync/write must be expressed through the
 * engine lifecycle hooks, never through a whole-action method.
 */
function assertHooksCapabilities(
  contract: ResourceContract,
  handler: SpecialResourceHandler,
  hooks: ResourcePhaseHooks
): void {
  for (const capability of contract.capabilities) {
    if (capability === "query" && typeof handler.query !== "function") {
      throw new CliError(`资源 ${contract.id} 声明 query 能力但未提供查询处理器`);
    }
    const hasPlanner = typeof hooks.plan === "function" || typeof hooks.aggregatePlan === "function";
    if (capability === "compare" && !hasPlanner) {
      throw new CliError(`资源 ${contract.id} 声明 compare 能力但缺少 plan/aggregatePlan 阶段钩子`);
    }
    if (capability === "sync") {
      if (!hasPlanner) {
        throw new CliError(`资源 ${contract.id} 声明 sync 能力但缺少 plan/aggregatePlan 阶段钩子`);
      }
      if (typeof hooks.apply !== "function" && (!contract.save || !contract.rollback)) {
        throw new CliError(`资源 ${contract.id} 声明 sync 能力但缺少 apply 阶段钩子或完整保存/回滚契约`);
      }
    }
    if (capability === "write") {
      if (typeof hooks.apply !== "function" && (!contract.save || !contract.rollback)) {
        throw new CliError(`资源 ${contract.id} 声明 write 能力但缺少 apply 阶段钩子或完整保存/回滚契约`);
      }
    }
  }
}

function assertExtensionPair(
  contract: ResourceContract,
  kind: "adapter" | "handler",
  implementation: ResourceAdapter | SpecialResourceHandler | undefined
): void {
  const declared = contract[kind];
  const label = kind === "adapter" ? "适配器" : "特殊处理器";
  if (declared && !implementation) {
    throw new CliError(`资源 ${contract.id} 声明了${label} ${declared} 但未提供实现`);
  }
  if (!declared && implementation) {
    throw new CliError(`资源 ${contract.id} 提供了未声明的${label}实现`);
  }
}

function registerUnique<T>(
  values: Map<string, T>,
  name: string,
  value: T,
  label: string
): void {
  const existing = values.get(name);
  if (existing && existing !== value) throw new CliError(`${label} ID 重复：${name}`);
  values.set(name, value);
}
