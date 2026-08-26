import type { ResourceContract } from "./core/contracts.js";
import { CliError, errorMessage, type CliErrorIssue } from "../errors.js";
import {
  createResourceModuleCatalog,
  type ResourceModule,
  type ResourceModuleCatalog
} from "./modules/contracts.js";
import {
  scanExternalResourceContracts,
  type LoadedExternalResourceContract
} from "./external/loader.js";
import { resourceModules } from "../domains/index.js";

/** Single composition root for API contracts and optional behavior extensions. */
export const builtInResourceCatalog = createResourceModuleCatalog(resourceModules);

export const resourceRegistry = builtInResourceCatalog.registry;
export const resourceContracts: readonly ResourceContract[] = resourceRegistry.contracts;
export const resourceAdapterRegistry = builtInResourceCatalog.adapterRegistry;
export const specialResourceHandlerRegistry = builtInResourceCatalog.handlerRegistry;
export const resourcePhaseHooksRegistry = builtInResourceCatalog.phaseHooksRegistry;

export interface LoadedResourceCatalog {
  catalog: ResourceModuleCatalog;
  issues: CliErrorIssue[];
}

/** Build the maximum usable catalog while isolating invalid external contracts. */
export async function loadResourceCatalog(
  contractsDirectory?: string,
  options: { allowMissingDirectory?: boolean } = {}
): Promise<LoadedResourceCatalog> {
  const scanned = contractsDirectory
    ? await scanExternalResourceContracts(contractsDirectory, options)
    : { contracts: [], issues: [] };
  const isolated = isolateUsableExternalContracts(scanned.contracts);
  return {
    catalog: composeResourceCatalog(
      isolated.contracts.map(({ contract }) => ({ contract }))
    ),
    issues: [...scanned.issues, ...isolated.issues]
      .sort(compareIssues)
  };
}

/** Validate already parsed external contracts against built-in IDs and aliases. */
export function validateExternalResourceContracts(
  contracts: readonly ResourceContract[]
): ResourceModuleCatalog {
  return composeResourceCatalog(contracts.map((contract) => ({ contract })));
}

function composeResourceCatalog(
  externalModules: readonly ResourceModule[]
): ResourceModuleCatalog {
  try {
    return createResourceModuleCatalog([...resourceModules, ...externalModules]);
  } catch (error) {
    if (error instanceof Error && /(?:重复|冲突)/.test(error.message)) {
      throw new CliError(error.message, 1, { code: "RESOURCE_CONTRACT_CONFLICT" });
    }
    throw new CliError(`资源契约无效：${errorMessage(error)}`, 1, {
      code: "RESOURCE_CONTRACT_INVALID",
      requiredInput: "resourceContract"
    });
  }
}

function isolateUsableExternalContracts(
  candidates: readonly LoadedExternalResourceContract[]
): { contracts: LoadedExternalResourceContract[]; issues: CliErrorIssue[] } {
  const issues: CliErrorIssue[] = [];
  const builtInNames = new Set(
    resourceModules.flatMap(({ contract }) => [contract.id, ...(contract.aliases ?? [])])
  );
  const claimants = new Map<string, LoadedExternalResourceContract[]>();
  for (const candidate of candidates) {
    for (const name of contractNames(candidate.contract)) {
      const entries = claimants.get(name) ?? [];
      entries.push(candidate);
      claimants.set(name, entries);
    }
  }

  const conflicting = new Map<LoadedExternalResourceContract, string[]>();
  for (const candidate of candidates) {
    const names = contractNames(candidate.contract).filter((name) =>
      builtInNames.has(name) || (claimants.get(name)?.length ?? 0) > 1
    );
    if (names.length > 0) conflicting.set(candidate, names);
  }
  for (const [candidate, names] of conflicting) {
    issues.push({
      path: candidate.path,
      message: `资源契约 ${candidate.contract.id} 的名称或别名冲突：${names.join(", ")}`
    });
  }

  let active = candidates.filter((candidate) => !conflicting.has(candidate));
  active = removeMissingDependencies(active, issues);

  const cyclicIds = findCyclicContractIds(active);
  if (cyclicIds.size > 0) {
    const retained: LoadedExternalResourceContract[] = [];
    for (const candidate of active) {
      if (cyclicIds.has(candidate.contract.id)) {
        issues.push({
          path: candidate.path,
          message: `资源契约 ${candidate.contract.id} 的依赖存在循环`
        });
      } else {
        retained.push(candidate);
      }
    }
    active = removeMissingDependencies(retained, issues);
  }
  return { contracts: active, issues };
}

function removeMissingDependencies(
  candidates: readonly LoadedExternalResourceContract[],
  issues: CliErrorIssue[]
): LoadedExternalResourceContract[] {
  const builtInIds = new Set(resourceModules.map(({ contract }) => contract.id));
  let active = [...candidates];
  while (true) {
    const available = new Set([...builtInIds, ...active.map(({ contract }) => contract.id)]);
    const missing = new Map<LoadedExternalResourceContract, string[]>();
    for (const candidate of active) {
      const dependencies = (candidate.contract.dependencies ?? [])
        .filter((dependency) => !available.has(dependency));
      if (dependencies.length > 0) missing.set(candidate, dependencies);
    }
    if (missing.size === 0) return active;
    for (const [candidate, dependencies] of missing) {
      issues.push({
        path: candidate.path,
        message: `资源契约 ${candidate.contract.id} 依赖不可用资源：${dependencies.join(", ")}`
      });
    }
    active = active.filter((candidate) => !missing.has(candidate));
  }
}

function findCyclicContractIds(
  candidates: readonly LoadedExternalResourceContract[]
): Set<string> {
  const byId = new Map(candidates.map((candidate) => [candidate.contract.id, candidate]));
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let nextIndex = 0;

  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowLinkById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const dependency of byId.get(id)?.contract.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      if (!indexById.has(dependency)) {
        visit(dependency);
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, lowLinkById.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, indexById.get(dependency)!));
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1) {
      for (const member of component) cyclic.add(member);
    }
  };

  for (const { contract } of candidates) {
    if (!indexById.has(contract.id)) visit(contract.id);
  }
  return cyclic;
}

function contractNames(contract: ResourceContract): string[] {
  return [contract.id, ...(contract.aliases ?? [])];
}

function compareIssues(left: CliErrorIssue, right: CliErrorIssue): number {
  return left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}

export function getResourceContract(name: string): ResourceContract {
  return resourceRegistry.get(name);
}

export function listResourceContracts(): ResourceContract[] {
  return resourceRegistry.list();
}
