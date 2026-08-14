import { CliError } from "../errors.js";
import {
  ResourceClient,
  type ContractQueryOptions,
  type ResourceRecord
} from "./client.js";
import {
  DependencyResolutionError,
  RecordMappingError,
  type BlockingIssue,
  type MissingDependency
} from "./specs.js";
import type { ResourceContract } from "./contracts.js";
import { assertTenantScope } from "../tenant.js";
import type { OperationRecorder } from "../operations/recorder.js";

export type ResourcePlanAction = "create" | "update" | "unchanged" | "blocked";

export interface ResourcePlanChange {
  key: string;
  action: ResourcePlanAction;
  changedFields: string[];
  before: ResourceRecord | null;
  desired: ResourceRecord | null;
  missingDependencies?: MissingDependency[];
  blockingIssues?: BlockingIssue[];
}

export interface ResourcePlan {
  kind: "eadp.resource.plan.v1";
  resource: string;
  sourceEnvironment?: string;
  targetEnvironment?: string;
  changes: ResourcePlanChange[];
  summary: Record<ResourcePlanAction, number>;
  missingDependencies: MissingDependency[];
  blockingIssues: BlockingIssue[];
}

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
  constructor(private readonly adapters: ResourceAdapterRegistry = createResourceAdapterRegistry()) {}

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
    const targetRows = await client.queryContract(contract, options.targetQuery);
    assertUniqueIdentities(targetRows, contract, "目标环境");
    const changes = await this.buildChanges(
      contract,
      records,
      targetRows,
      client,
      options.targetTenantCode
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
    const writable = plan.changes.filter(
      (change) => change.action === "create" || change.action === "update"
    );
    if (options.apply) await this.saveChanges(contract, client, writable, options.recorder);
    let verified = !options.apply;
    if (options.apply) {
      const after = await client.queryContract(contract, options.targetQuery);
      verified = plan.changes.filter((change) => change.action !== "blocked").every((change) => {
        const actual = findByIdentity(after, contract, change.key);
        return actual !== undefined && change.desired !== null &&
          diffFields(actual, change.desired, contract, this.getAdapter(contract)).length === 0;
      });
      if (!verified) throw new CliError(`资源 ${contract.id} 写入后回查失败`);
    }
    return {
      ...plan,
      applied: options.apply === true && writable.length > 0,
      skippedBlocked: options.apply ? plan.summary.blocked : 0,
      verified
    };
  }

  async compare(
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
    const [sourceRows, targetRows] = await Promise.all([
      sourceClient.queryContract(contract, options.sourceQuery),
      targetClient.queryContract(contract, options.targetQuery)
    ]);
    assertUniqueIdentities(sourceRows, contract, "源环境");
    assertUniqueIdentities(targetRows, contract, "目标环境");
    const changes = await this.buildChanges(
      contract,
      sourceRows,
      targetRows,
      targetClient,
      options.targetTenantCode
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
    const plan = await this.compare(
      contract,
      sourceClient,
      targetClient,
      environments,
      options
    );
    const writable = plan.changes.filter(
      (change) => change.action === "create" || change.action === "update"
    );
    if (options.apply) await this.saveChanges(contract, targetClient, writable, options.recorder);
    let verified = !options.apply;
    if (options.apply) {
      const after = await targetClient.queryContract(contract, options.targetQuery);
      const safe = plan.changes.filter((change) => change.action !== "blocked");
      verified = safe.every((change) => {
        const actual = findByIdentity(after, contract, change.key);
        return actual !== undefined && change.desired !== null &&
          diffFields(actual, change.desired, contract, this.getAdapter(contract)).length === 0;
      });
      if (!verified) throw new CliError(`资源 ${contract.id} 写入后回查失败`);
    }
    return {
      ...plan,
      applied: options.apply === true && writable.length > 0,
      skippedBlocked: options.apply ? plan.summary.blocked : 0,
      verified
    };
  }

  private async buildChanges(
    contract: ResourceContract,
    sourceRows: ResourceRecord[],
    targetRows: ResourceRecord[],
    targetClient: ResourceClient,
    targetTenantCode?: string
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
      const before = findByIdentity(targetRows, contract, key);
      let desired: ResourceRecord;
      try {
        desired = adapter
          ? await adapter.toDesired(source, targetClient, { targetTenantCode: targetTenantCode ?? "" })
          : pickWritableFields(source, contract);
      } catch (error) {
        if (error instanceof RecordMappingError) {
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
    return changes;
  }

  private getAdapter(contract: ResourceContract): ResourceAdapter | undefined {
    if (!contract.adapter) return undefined;
    return this.adapters.get(contract.adapter);
  }

  private async saveChanges(
    contract: ResourceContract,
    client: ResourceClient,
    changes: ResourcePlanChange[],
    recorder?: OperationRecorder
  ): Promise<void> {
    for (const change of changes) {
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
        deleteMethod: rollback.deleteMethod,
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

export interface ResourceAdapterRegistry {
  get(name: string): ResourceAdapter;
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

function makePlan(
  resource: string,
  changes: ResourcePlanChange[],
  environments?: { source: string; target: string }
): ResourcePlan {
  const summary: Record<ResourcePlanAction, number> = { create: 0, update: 0, unchanged: 0, blocked: 0 };
  for (const change of changes) summary[change.action] += 1;
  return {
    kind: "eadp.resource.plan.v1",
    resource,
    ...(environments ? { sourceEnvironment: environments.source, targetEnvironment: environments.target } : {}),
    changes,
    summary,
    missingDependencies: uniqueMissingDependencies(changes),
    blockingIssues: uniqueBlockingIssues(changes)
  };
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
  key: string
): ResourceRecord | undefined {
  const matches = records.filter((record) => {
    try { return identityValue(record, contract) === key; } catch { return false; }
  });
  if (matches.length > 1) throw new CliError(`目标环境业务唯一键重复：${identityDescription(contract)}=${key}`);
  return matches[0];
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

function uniqueMissingDependencies(changes: ResourcePlanChange[]): MissingDependency[] {
  const values = new Map<string, MissingDependency>();
  for (const change of changes) for (const item of change.missingDependencies ?? []) {
    values.set([item.resource, item.identityField, item.value.toLocaleLowerCase(), item.reason].join(":"), item);
  }
  return [...values.values()];
}

function uniqueBlockingIssues(changes: ResourcePlanChange[]): BlockingIssue[] {
  const values = new Map<string, BlockingIssue>();
  for (const change of changes) for (const item of change.blockingIssues ?? []) {
    values.set([item.resource, item.field, item.reason, item.message].join(":"), item);
  }
  return [...values.values()];
}
