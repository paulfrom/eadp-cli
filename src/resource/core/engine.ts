import { CliError } from "../../errors.js";
import {
  ResourceClient,
  type ContractQueryOptions,
  type ResourceRecord
} from "./client.js";
import {
  DependencyResolutionError,
  RecordMappingError
} from "./errors.js";
import type { ResourceContract, ResourceRegistry } from "./contracts.js";
import { assertTenantScope } from "../../tenant.js";
import type { OperationRecorder } from "../../operations/recorder.js";
import {
  makePlan,
  writableChanges,
  type ResourcePlan,
  type ResourcePlanChange
} from "./change-set.js";

export {
  RESOURCE_CHANGE_SET_KIND,
  makePlan,
  summarizeChanges,
  uniqueBlockingIssues,
  uniqueMissingDependencies,
  writableChanges
} from "./change-set.js";
export type {
  ResourceChange,
  ResourceChangeSet,
  ResourcePlan,
  ResourcePlanAction,
  ResourcePlanChange
} from "./change-set.js";

export interface ResourceQueryResult {
  kind: "eadp.resource.query.v1";
  resource: string;
  environment: string;
  items: ResourceRecord[];
  total: number;
}

export interface ResourceExecutionResult extends ResourcePlan {
  applied: boolean;
  skippedBlocked: number;
  verified: boolean;
}

export interface ResourceEngineOptions {
  targetTenantCode?: string;
  sourceQuery?: ContractQueryOptions;
  targetQuery?: ContractQueryOptions;
  recorder?: OperationRecorder;
  /** Selector values resolved by the command from the contract's declared selectors. */
  selectors?: Readonly<Record<string, string>>;
}

/**
 * Phase-extension hooks.  A resource that declares these overrides a single
 * phase of the generic engine lifecycle; the engine still owns the blocked
 * gate, the recorder lifecycle, the envelope, and the verify gate.
 */
export interface ResourcePlanContext {
  contract: ResourceContract;
  targetClient: ResourceClient;
  targetTenantCode: string | undefined;
  selectors: Readonly<Record<string, string>>;
}

export interface ResourceApplyContext {
  contract: ResourceContract;
  plan: ResourcePlan;
  targetTenantCode: string | undefined;
  recorder: OperationRecorder | undefined;
}

export interface ResourceVerifyContext {
  contract: ResourceContract;
  plan: ResourcePlan;
  targetTenantCode: string | undefined;
}

export interface ResourceAggregatePlanContext {
  contract: ResourceContract;
  sourceClient: ResourceClient;
  targetClient: ResourceClient;
  targetTenantCode: string | undefined;
  selectors: Readonly<Record<string, string>>;
}

/** Aggregate planning result: changes plus optional extra summary/details. */
export interface ResourceAggregatePlan {
  changes: ResourcePlanChange[];
  extraSummary?: Record<string, number>;
  details?: Record<string, unknown>;
  /** True when the apply phase performs work beyond the writable records (e.g. relations). */
  appliedExtra?: boolean;
}

export interface ResourcePhaseHooks {
  /** Override source/target read (default: client.queryContract). */
  load?(client: ResourceClient, contract: ResourceContract, options: ContractQueryOptions): Promise<ResourceRecord[]>;
  /** Override planning (default: buildChanges). Must still emit the five actions. */
  plan?(source: ResourceRecord[], target: ResourceRecord[], context: ResourcePlanContext): Promise<ResourcePlanChange[]>;
  /**
   * Aggregate planning: load both sides and plan in one phase. Used by
   * multi-resource resources whose source/target read is not a single record
   * list. Mutually exclusive with `plan` for a given resource.
   */
  aggregatePlan?(context: ResourceAggregatePlanContext): Promise<ResourceAggregatePlan>;
  /** Override the apply phase (default: saveChanges). Only invoked when apply is true. */
  apply?(writable: ResourcePlanChange[], client: ResourceClient, context: ResourceApplyContext): Promise<void>;
  /** Override post-write verification (default: re-query + diffFields). */
  verify?(client: ResourceClient, context: ResourceVerifyContext): Promise<boolean>;
}

export interface ResourcePhaseHooksRegistry {
  find(name: string): ResourcePhaseHooks | undefined;
}

export function createResourcePhaseHooksRegistry(
  entries: ReadonlyArray<readonly [string, ResourcePhaseHooks]> = []
): ResourcePhaseHooksRegistry {
  const hooks = new Map<string, ResourcePhaseHooks>();
  for (const [name, value] of entries) {
    if (!name.trim() || hooks.has(name)) throw new CliError(`资源阶段钩子重复或无效：${name}`);
    hooks.set(name, value);
  }
  return {
    find(name: string): ResourcePhaseHooks | undefined {
      return hooks.get(name);
    }
  };
}

/** Tenant validation used before any query, including source/target migration. */
export function assertResourceTenant(
  contract: ResourceContract,
  tenantCode: string | undefined,
  environmentName: string
): void {
  if (contract.tenant.policy === "any") {
    if (!tenantCode) {
      throw new CliError(`环境 ${environmentName} 未记录 tenantCode，请重新执行 env add 验证 Token`);
    }
    return;
  }
  assertTenantScope(tenantCode, contract.tenant.policy, environmentName);
}

export function assertMigrationTenants(
  contract: ResourceContract,
  source: { name: string; tenantCode?: string },
  target: { name: string; tenantCode?: string }
): void {
  // Keep this synchronous and side-effect free: callers invoke it immediately
  // after resolving environments and before constructing/using a client.
  assertResourceTenant(contract, source.tenantCode, source.name);
  assertResourceTenant(contract, target.tenantCode, target.name);
}

/**
 * Generic resource operations.  Commands only parse arguments and delegate
 * here, so adding a resource contract does not require another if/else branch
 * in the command layer.
 */
export class ResourceEngine {
  constructor(
    private readonly adapters: ResourceAdapterRegistry = createResourceAdapterRegistry(),
    private readonly phaseHooks: ResourcePhaseHooksRegistry = createResourcePhaseHooksRegistry(),
    private readonly registry?: ResourceRegistry
  ) {}

  async query(
    contract: ResourceContract,
    client: ResourceClient,
    environment: string,
    options: { filters?: import("./client.js").ResourceFilter[]; quickSearchValue?: string } = {}
  ): Promise<ResourceQueryResult> {
    if (!contract.capabilities.includes("query")) {
      throw new CliError(`资源 ${contract.id} 未声明 query 能力`);
    }
    const items = await client.queryContract(contract, options);
    return {
      kind: "eadp.resource.query.v1",
      resource: contract.id,
      environment,
      items,
      total: items.length
    };
  }

  async planWrite(
    contract: ResourceContract,
    client: ResourceClient,
    data: ResourceRecord | ResourceRecord[],
    options: ResourceEngineOptions = {}
  ): Promise<ResourcePlan> {
    if (!contract.capabilities.includes("write")) {
      throw new CliError(`资源 ${contract.id} 未声明 write 能力`);
    }
    this.getAdapter(contract);
    const records = (Array.isArray(data) ? data : [data]).map((record) =>
      bindTargetTenant(record, contract, options.targetTenantCode)
    );
    assertUniqueIdentities(records, contract, "写入数据");
    const targetRows = await this.loadRows(client, contract, options.targetQuery);
    if (!this.hooksFor(contract)?.plan) {
      assertUniqueIdentities(targetRows, contract, "目标环境");
    }
    const changes = await this.planChanges(
      contract,
      records,
      targetRows,
      client,
      options.targetTenantCode,
      options.selectors,
      false,
      false
    );
    return makePlan(contract.id, changes);
  }

  async write(
    contract: ResourceContract,
    client: ResourceClient,
    data: ResourceRecord | ResourceRecord[],
    options: ResourceEngineOptions & { apply?: boolean } = {}
  ): Promise<ResourceExecutionResult> {
    const plan = await this.planWrite(contract, client, data, options);
    return this.executePlan(contract, client, plan, options);
  }

  async compare(
    contract: ResourceContract,
    sourceClient: ResourceClient,
    targetClient: ResourceClient,
    environments: { source: string; target: string },
    options: ResourceEngineOptions = {}
  ): Promise<ResourcePlan> {
    const order = this.dependencyOrder(contract);
    if (order.length > 1) {
      const planned = await this.planDependencyClosure(
        order,
        sourceClient,
        targetClient,
        environments,
        options
      );
      return this.mergePlans(contract, planned, environments);
    }
    return this.compareSingle(contract, sourceClient, targetClient, environments, options);
  }

  private async compareSingle(
    contract: ResourceContract,
    sourceClient: ResourceClient,
    targetClient: ResourceClient,
    environments: { source: string; target: string },
    options: ResourceEngineOptions = {}
  ): Promise<ResourcePlan> {
    if (!contract.capabilities.includes("compare")) {
      throw new CliError(`资源 ${contract.id} 未声明 compare 能力`);
    }
    this.getAdapter(contract);
    const hooks = this.hooksFor(contract);
    if (hooks?.aggregatePlan) {
      const aggregate = await hooks.aggregatePlan({
        contract,
        sourceClient,
        targetClient,
        targetTenantCode: options.targetTenantCode,
        selectors: options.selectors ?? {}
      });
      return makePlan(contract.id, aggregate.changes, environments, {
        ...(aggregate.extraSummary ? { summary: aggregate.extraSummary } : {}),
        ...(aggregate.details ? { details: aggregate.details } : {}),
        ...(aggregate.appliedExtra ? { appliedExtra: aggregate.appliedExtra } : {})
      });
    }
    const [sourceRows, targetRows] = await Promise.all([
      this.loadRows(sourceClient, contract, options.sourceQuery),
      this.loadRows(targetClient, contract, options.targetQuery)
    ]);
    if (!hooks?.plan) {
      assertUniqueIdentities(sourceRows, contract, "源环境");
      assertUniqueIdentities(targetRows, contract, "目标环境");
    }
    const changes = await this.planChanges(
      contract,
      sourceRows,
      targetRows,
      targetClient,
      options.targetTenantCode,
      options.selectors,
      true
    );
    return makePlan(contract.id, changes, environments);
  }

  async sync(
    contract: ResourceContract,
    sourceClient: ResourceClient,
    targetClient: ResourceClient,
    environments: { source: string; target: string },
    options: ResourceEngineOptions & { apply?: boolean } = {}
  ): Promise<ResourceExecutionResult> {
    if (!contract.capabilities.includes("sync")) {
      throw new CliError(`资源 ${contract.id} 未声明 sync 能力`);
    }
    const order = this.dependencyOrder(contract);
    if (order.length === 1) {
      const plan = await this.compareSingle(contract, sourceClient, targetClient, environments, options);
      return this.executePlan(contract, targetClient, plan, options);
    }
    const planned = await this.planDependencyClosure(
      order,
      sourceClient,
      targetClient,
      environments,
      options
    );
    if (!options.apply) {
      return this.executionFromPlan(this.mergePlans(contract, planned, environments), false);
    }

    const forward = new Map<string, ResourcePlan>();
    let applied = false;
    for (const item of order) {
      const plan = await this.compareSingleForResource(
        item,
        sourceClient,
        targetClient,
        environments,
        options,
        item.id === contract.id ? options.sourceQuery : undefined,
        item.id === contract.id ? options.selectors : undefined
      );
      forward.set(item.id, plan);
      const phase = filterPlanChanges(plan, (change) =>
        change.action === "create" || change.action === "update" || change.action === "unchanged" || change.action === "blocked"
      );
      const result = await this.executePlan(
        item,
        targetClient.forService(item.service),
        phase,
        options
      );
      applied = applied || result.applied;
    }

    const reverse = [...order].reverse();
    const afterDelete = new Map<string, ResourcePlan>();
    for (const item of reverse) {
      const plan = await this.compareSingleForResource(
        item,
        sourceClient,
        targetClient,
        environments,
        options,
        item.id === contract.id ? options.sourceQuery : undefined,
        item.id === contract.id ? options.selectors : undefined
      );
      const phase = filterPlanChanges(plan, (change) =>
        change.action === "delete" || change.action === "blocked" || change.action === "unchanged"
      );
      const result = await this.executePlan(
        item,
        targetClient.forService(item.service),
        phase,
        options
      );
      afterDelete.set(item.id, plan);
      applied = applied || result.applied;
    }

    const finalPlans = order.map((item) => mergeResourcePlans(
      forward.get(item.id)!,
      afterDelete.get(item.id)
    ));
    const finalPlan = this.mergePlans(contract, finalPlans, environments);
    return {
      ...finalPlan,
      applied,
      skippedBlocked: finalPlan.summary.blocked ?? 0,
      verified: true
    };
  }

  private dependencyOrder(contract: ResourceContract): ResourceContract[] {
    if (!contract.dependencies?.length) return [contract];
    if (!this.registry) {
      throw new CliError(`资源 ${contract.id} 声明了依赖，但资源引擎未提供契约注册表`);
    }
    const ordered: ResourceContract[] = [];
    const visited = new Set<string>();
    const visit = (current: ResourceContract): void => {
      if (visited.has(current.id)) return;
      for (const dependency of current.dependencies ?? []) visit(this.registry!.get(dependency));
      visited.add(current.id);
      ordered.push(current);
    };
    visit(contract);
    return ordered;
  }

  private async planDependencyClosure(
    order: ResourceContract[],
    sourceClient: ResourceClient,
    targetClient: ResourceClient,
    environments: { source: string; target: string },
    options: ResourceEngineOptions
  ): Promise<ResourcePlan[]> {
    const root = order[order.length - 1]!;
    const plans: ResourcePlan[] = [];
    for (const item of order) {
      plans.push(await this.compareSingleForResource(
        item,
        sourceClient,
        targetClient,
        environments,
        options,
        item.id === root.id ? options.sourceQuery : undefined,
        item.id === root.id ? options.selectors : undefined
      ));
    }
    return plans;
  }

  private async compareSingleForResource(
    contract: ResourceContract,
    sourceClient: ResourceClient,
    targetClient: ResourceClient,
    environments: { source: string; target: string },
    options: ResourceEngineOptions,
    sourceQuery?: ContractQueryOptions,
    selectors?: Readonly<Record<string, string>>
  ): Promise<ResourcePlan> {
    const delegatedOptions: ResourceEngineOptions = { ...options };
    if (sourceQuery === undefined) delete delegatedOptions.sourceQuery;
    else delegatedOptions.sourceQuery = sourceQuery;
    if (selectors === undefined) delete delegatedOptions.selectors;
    else delegatedOptions.selectors = selectors;
    return this.compareSingle(
      contract,
      sourceClient.forService(contract.service),
      targetClient.forService(contract.service),
      environments,
      delegatedOptions
    );
  }

  private mergePlans(
    root: ResourceContract,
    plans: ResourcePlan[],
    environments: { source: string; target: string }
  ): ResourcePlan {
    const changes = plans.flatMap((plan) => plan.changes.map((change) =>
      plan.resource === root.id ? change : { ...change, resource: plan.resource }
    ));
    return makePlan(root.id, changes, environments);
  }

  private executionFromPlan(plan: ResourcePlan, apply: boolean): ResourceExecutionResult {
    return {
      ...plan,
      applied: apply && writableChanges(plan.changes).length > 0,
      skippedBlocked: apply ? (plan.summary.blocked ?? 0) : 0,
      verified: true
    };
  }

  /** Execute any ordinary write/sync plan through one lifecycle. */
  private async executePlan(
    contract: ResourceContract,
    client: ResourceClient,
    plan: ResourcePlan,
    options: ResourceEngineOptions & { apply?: boolean }
  ): Promise<ResourceExecutionResult> {
    const writable = writableChanges(plan.changes);
    // `blocked` changes are intentionally absent from writable.  This is the
    // single safety gate used by both write and sync.
    if (options.apply) {
      const hooks = this.hooksFor(contract);
      if (hooks?.apply) {
        await hooks.apply(writable, client, {
          contract,
          plan,
          targetTenantCode: options.targetTenantCode,
          recorder: options.recorder
        });
      } else {
        await this.saveChanges(contract, client, writable, options.recorder);
      }
    }
    let verified = !options.apply;
    if (options.apply) {
      const hooks = this.hooksFor(contract);
      if (hooks?.verify) {
        verified = await hooks.verify(client, {
          contract,
          plan,
          targetTenantCode: options.targetTenantCode
        });
      } else {
        const after = await this.loadRows(client, contract, options.targetQuery);
        const safe = plan.changes.filter((change) => change.action !== "blocked");
        verified = safe.every((change) => {
          const actual = findByIdentity(after, contract, change.key);
          if (change.action === "delete") return actual === undefined;
          return actual !== undefined && change.desired !== null &&
            diffFields(actual, change.desired, contract, this.getAdapter(contract)).length === 0;
        });
      }
      if (!verified) throw new CliError(`资源 ${contract.id} 写入后回查失败`);
    }
    return {
      ...plan,
      applied: options.apply === true && (writable.length > 0 || plan.appliedExtra === true),
      skippedBlocked: options.apply ? (plan.summary.blocked ?? 0) : 0,
      verified
    };
  }

  private async buildChanges(
    contract: ResourceContract,
    sourceRows: ResourceRecord[],
    targetRows: ResourceRecord[],
    targetClient: ResourceClient,
    targetTenantCode?: string,
    includeTargetOnly = true,
    allowRecordBlocking = true
  ): Promise<ResourcePlanChange[]> {
    const adapter = this.getAdapter(contract);
    const mappedKeys = new Set<string>();
    const changes: ResourcePlanChange[] = [];
    for (const source of sourceRows) {
      const key = identityValue(source, contract, targetIdentityOverrides(contract, targetTenantCode));
      if (mappedKeys.has(key)) {
        throw new CliError(`源环境记录映射后业务唯一键重复：${identityDescription(contract)}=${key}`);
      }
      mappedKeys.add(key);
      const before = findByIdentity(
        targetRows,
        contract,
        key,
        targetIdentityOverrides(contract, targetTenantCode)
      );
      let desired: ResourceRecord;
      try {
        desired = adapter
          ? await adapter.toDesired(source, targetClient, { targetTenantCode: targetTenantCode ?? "" })
          : pickWritableFields(source, contract);
      } catch (error) {
        if (error instanceof RecordMappingError) {
          if (!allowRecordBlocking) throw error;
          changes.push({ key, action: "blocked", changedFields: [], before: before ?? null, desired: null, blockingIssues: error.blockingIssues });
          continue;
        }
        if (error instanceof DependencyResolutionError) {
          changes.push({ key, action: "blocked", changedFields: [], before: before ?? null, desired: null, missingDependencies: error.missingDependencies });
          continue;
        }
        throw error;
      }
      desired = applyDefaults(contract, desired, before, targetTenantCode, adapter);
      if (before && before.id !== undefined) desired.id = before.id;
      const changedFields = diffFields(before, desired, contract, adapter);
      changes.push({
        key,
        action: before === undefined ? "create" : changedFields.length === 0 ? "unchanged" : "update",
        changedFields,
        before: before ?? null,
        desired
      });
    }
    if (includeTargetOnly) {
      for (const target of targetRows) {
        let key: string;
        try {
          key = identityValue(target, contract, targetIdentityOverrides(contract, targetTenantCode));
        } catch (error) {
          changes.push({
            key: `target-only-${changes.length + 1}`,
            action: "blocked",
            changedFields: [],
            before: target,
            desired: null,
            targetOnly: true,
            blockingIssues: [{
              resource: contract.id,
              field: "identity",
              reason: "invalid",
              value: null,
              message: error instanceof Error
                ? `目标独有记录无法安全删除：${error.message}`
                : "目标独有记录缺少有效业务唯一键，不能安全删除"
            }]
          });
          continue;
        }
        if (mappedKeys.has(key)) continue;
        if (contract.deletion && target.id !== undefined && target.id !== null) {
          changes.push({
            key,
            action: "delete",
            changedFields: [],
            before: target,
            desired: null,
            targetOnly: true
          });
        } else {
          changes.push({
            key,
            action: "blocked",
            changedFields: [],
            before: target,
            desired: null,
            targetOnly: true,
            blockingIssues: [{
              resource: contract.id,
              field: "target-only",
              reason: "undeclared-delete",
              identityField: contract.identityFields.join(","),
              value: key,
              message: `目标记录 ${key} 仅存在于目标环境，资源未声明删除契约`
            }]
          });
        }
      }
    }
    return changes;
  }

  private getAdapter(contract: ResourceContract): ResourceAdapter | undefined {
    if (!contract.adapter) return undefined;
    return this.adapters.get(contract.adapter);
  }

  private hooksFor(contract: ResourceContract): ResourcePhaseHooks | undefined {
    return this.phaseHooks.find(contract.id);
  }

  private async loadRows(
    client: ResourceClient,
    contract: ResourceContract,
    options: ContractQueryOptions = {}
  ): Promise<ResourceRecord[]> {
    const hooks = this.hooksFor(contract);
    if (hooks?.load) return hooks.load(client, contract, options);
    return client.queryContract(contract, options);
  }

  private async planChanges(
    contract: ResourceContract,
    source: ResourceRecord[],
    target: ResourceRecord[],
    targetClient: ResourceClient,
    targetTenantCode?: string,
    selectors: Readonly<Record<string, string>> = {},
    includeTargetOnly = true,
    allowRecordBlocking = true
  ): Promise<ResourcePlanChange[]> {
    const hooks = this.hooksFor(contract);
    if (hooks?.plan) {
      return hooks.plan(source, target, {
        contract,
        targetClient,
        targetTenantCode,
        selectors
      });
    }
    return this.buildChanges(
      contract,
      source,
      target,
      targetClient,
      targetTenantCode,
      includeTargetOnly,
      allowRecordBlocking
    );
  }

  private async saveChanges(
    contract: ResourceContract,
    client: ResourceClient,
    changes: ResourcePlanChange[],
    recorder?: OperationRecorder
  ): Promise<void> {
    for (const change of changes) {
      if (change.action === "delete") {
        if (!contract.deletion) throw new CliError(`资源 ${contract.id} 未声明删除契约`);
        const entityId = recordId(change.before, contract.id);
        await client.deleteContract(contract, entityId);
        if (recorder) {
          await recorder.recordAction({
            type: "delete-entity",
            service: contract.deletion.service,
            resource: contract.deletion.resource,
            entityId,
            expected: restoreSnapshot(change.before!, contract),
            remove: contract.deletion.remove,
            lookup: contract.deletion.lookup,
            restore: contract.deletion.restore,
            tenantPolicy: contract.tenant.policy
          });
        }
        continue;
      }
      const saved = await client.saveContract(contract, change.desired!);
      if (change.action !== "create" || !recorder) continue;
      const rollback = contract.rollback;
      if (!rollback) throw new CliError(`资源 ${contract.id} 缺少安全回滚契约`);
      await recorder.recordAction({
        type: "create-entity",
        service: rollback.service,
        resource: rollback.resource,
        entityId: String(saved.id),
        expected: change.desired!,
        deleteMethod: rollback.remove.method,
        remove: rollback.remove,
        lookup: rollback.lookup,
        tenantPolicy: contract.tenant.policy
      });
    }
  }
}

export interface ResourceAdapter {
  toDesired(
    source: ResourceRecord,
    targetClient: ResourceClient,
    context: { targetTenantCode: string }
  ): Promise<ResourceRecord>;
  compareValue?(record: ResourceRecord, field: string): unknown;
  preserveTargetFields?: string[];
}

function filterPlanChanges(
  plan: ResourcePlan,
  predicate: (change: ResourcePlanChange) => boolean
): ResourcePlan {
  const changes = plan.changes.filter(predicate);
  return makePlan(
    plan.resource,
    changes,
    plan.sourceEnvironment !== undefined && plan.targetEnvironment !== undefined
      ? { source: plan.sourceEnvironment, target: plan.targetEnvironment }
      : undefined,
    {
      ...(plan.details ? { details: plan.details } : {}),
      ...(plan.appliedExtra ? { appliedExtra: plan.appliedExtra } : {})
    }
  );
}

function mergeResourcePlans(
  first: ResourcePlan,
  second: ResourcePlan | undefined
): ResourcePlan {
  if (!second) return first;
  const changes = new Map(first.changes.map((change) => [change.key, change]));
  for (const change of second.changes) {
    if (change.targetOnly && (change.action === "delete" || change.action === "blocked")) {
      changes.set(change.key, change);
    }
  }
  return makePlan(
    first.resource,
    [...changes.values()],
    first.sourceEnvironment !== undefined && first.targetEnvironment !== undefined
      ? { source: first.sourceEnvironment, target: first.targetEnvironment }
      : undefined
  );
}

export interface ResourceAdapterRegistry {
  get(name: string): ResourceAdapter;
  find(name: string): ResourceAdapter | undefined;
}

export function createResourceAdapterRegistry(
  entries: ReadonlyArray<readonly [string, ResourceAdapter]> = []
): ResourceAdapterRegistry {
  const adapters = new Map<string, ResourceAdapter>();
  for (const [name, adapter] of entries) {
    if (!name.trim() || adapters.has(name)) throw new CliError(`资源适配器重复或无效：${name}`);
    adapters.set(name, adapter);
  }
  return {
    get(name: string): ResourceAdapter {
      const adapter = adapters.get(name);
      if (!adapter) throw new CliError(`资源适配器未注册：${name}`);
      return adapter;
    },
    find(name: string): ResourceAdapter | undefined {
      return adapters.get(name);
    }
  };
}

function pickWritableFields(source: ResourceRecord, contract: ResourceContract): ResourceRecord {
  const desired: ResourceRecord = {};
  for (const field of contract.writableFields) if (field in source) desired[field] = source[field];
  return desired;
}

function applyDefaults(
  contract: ResourceContract,
  desired: ResourceRecord,
  before: ResourceRecord | undefined,
  targetTenantCode?: string,
  adapter?: ResourceAdapter
): ResourceRecord {
  const result = { ...desired };
  if (!before) {
    for (const [field, value] of Object.entries(contract.defaults?.create ?? {})) {
      if (isMissingValue(result[field])) result[field] = value;
    }
  }
  if (targetTenantCode && contract.tenant.bindField) result[contract.tenant.bindField] = targetTenantCode;
  for (const field of contract.writableFields) {
    if (before && !(field in result) && field in before) result[field] = before[field];
  }
  for (const field of [
    ...(contract.defaults?.preserveTargetFields ?? []),
    ...(adapter?.preserveTargetFields ?? [])
  ]) {
    if (before && field in before) result[field] = before[field];
  }
  for (const field of contract.defaults?.preserveTargetFieldsWhenMissing ?? []) {
    if (before && isMissingValue(result[field]) && field in before) result[field] = before[field];
  }
  return result;
}

function bindTargetTenant(
  record: ResourceRecord,
  contract: ResourceContract,
  targetTenantCode?: string
): ResourceRecord {
  if (!targetTenantCode || !contract.tenant.bindField) return { ...record };
  return { ...record, [contract.tenant.bindField]: targetTenantCode };
}

function targetIdentityOverrides(
  contract: ResourceContract,
  targetTenantCode?: string
): Record<string, string> {
  return targetTenantCode && contract.tenant.bindField
    ? { [contract.tenant.bindField]: targetTenantCode }
    : {};
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function identityValue(
  record: ResourceRecord,
  contract: ResourceContract,
  overrides: Record<string, string> = {}
): string {
  const values = contract.identityFields.map((field) => {
    const value = overrides[field] ?? record[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new CliError(`资源 ${contract.id} 缺少有效业务唯一键字段 ${field}`);
    }
    return value.trim().toLocaleLowerCase();
  });
  return values.length === 1
    ? values[0]!
    : JSON.stringify(Object.fromEntries(contract.identityFields.map((field, i) => [field, values[i]!]))) as string;
}

function findByIdentity(
  records: ResourceRecord[],
  contract: ResourceContract,
  key: string,
  overrides: Record<string, string> = {}
): ResourceRecord | undefined {
  const matches = records.filter((record) => {
    try { return identityValue(record, contract, overrides) === key; } catch { return false; }
  });
  if (matches.length > 1) throw new CliError(`目标环境业务唯一键重复：${identityDescription(contract)}=${key}`);
  return matches[0];
}

function recordId(record: ResourceRecord | null, resource: string): string {
  const value = record?.id;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new CliError(`资源 ${resource} 的目标记录缺少有效 ID，不能执行删除`);
  }
  return String(value);
}

function restoreSnapshot(record: ResourceRecord, contract: ResourceContract): ResourceRecord {
  const snapshot: ResourceRecord = {};
  if (record.id !== undefined) snapshot.id = record.id;
  for (const field of contract.writableFields) {
    if (field in record) snapshot[field] = record[field];
  }
  return snapshot;
}

function diffFields(
  before: ResourceRecord | undefined,
  desired: ResourceRecord,
  contract: ResourceContract,
  adapter?: ResourceAdapter
): string[] {
  if (!before) return contract.compareFields.filter((field) => field in desired);
  return contract.compareFields.filter((field) =>
    JSON.stringify(adapter?.compareValue?.(before, field) ?? before[field]) !==
    JSON.stringify(adapter?.compareValue?.(desired, field) ?? desired[field])
  );
}

function assertUniqueIdentities(records: ResourceRecord[], contract: ResourceContract, label: string): void {
  const keys = new Set<string>();
  for (const record of records) {
    const key = identityValue(record, contract);
    if (keys.has(key)) throw new CliError(`${label}业务唯一键重复：${identityDescription(contract)}=${key}`);
    keys.add(key);
  }
}

function identityDescription(contract: ResourceContract): string { return contract.identityFields.join("+"); }
