import type { ResolvedEnvironment } from "../config/resolve.js";
import { CliError, errorMessage } from "../errors.js";
import { sendRequest } from "../http/client.js";
import { assertPathTenantScope, assertTenantScope } from "../tenant.js";
import { OperationLogStore, type AssignDataValuesAction, type AssignRelationsAction,
  type CreateEntityAction, type DeleteEntityAction, type OperationAction, type OperationRecord } from "./store.js";

type RecordValue = Record<string, unknown>;

export async function rollbackOperation(options: {
  store: OperationLogStore;
  operationId: string;
  environment: ResolvedEnvironment;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  await options.store.cleanup();
  const record = await options.store.load(options.operationId);
  if (record.environment !== options.environment.name) {
    throw new CliError(`操作 ${record.id} 绑定环境 ${record.environment}，不能使用 ${options.environment.name} 回滚`);
  }
  if (record.status === "rolled-back") return result(record, 0, record.actions.length, true);

  // Preflight every action that may still touch EADP. This must happen before
  // findEntity/getChildren/getDataValues so a mixed operation cannot perform a
  // non-global request and only then discover that a global resource is being
  // rolled back from the wrong tenant.
  preflightRollbackOperation(record, options.environment);

  record.status = "rolling-back";
  delete record.error;
  await save(record, options.store);
  let rolledBack = 0;
  let alreadyAbsent = 0;
  try {
    for (const action of [...record.actions].reverse()) {
      if (action.status === "rolled-back" || action.status === "not-applied") {
        alreadyAbsent++;
        continue;
      }
      const changed = await rollbackAction(action, options.environment, options.timeoutMs);
      action.status = changed ? "rolled-back" : "not-applied";
      changed ? rolledBack++ : alreadyAbsent++;
      await save(record, options.store);
    }
    record.status = "rolled-back";
    await save(record, options.store);
    return result(record, rolledBack, alreadyAbsent, true);
  } catch (error) {
    record.status = "rollback-failed";
    record.error = errorMessage(error);
    await save(record, options.store);
    throw error;
  }
}

/**
 * Validate every active action in a record before any remote rollback request.
 *
 * This is intentionally synchronous and side-effect free so batch callers can
 * preflight all selected records before the first operation is changed.
 */
export function preflightRollbackOperation(record: OperationRecord, environment: ResolvedEnvironment): void {
  if (record.environment !== environment.name) {
    throw new CliError(`操作 ${record.id} 绑定环境 ${record.environment}，不能使用 ${environment.name} 回滚`);
  }
  for (const action of record.actions) {
    if (action.status === "rolled-back" || action.status === "not-applied") continue;
    assertRollbackActionTenantScope(action, environment);
  }
}

async function rollbackAction(action: OperationAction, env: ResolvedEnvironment, timeoutMs: number): Promise<boolean> {
  if (action.type === "create-entity") return rollbackCreate(action, env, timeoutMs);
  if (action.type === "delete-entity") return rollbackDelete(action, env, timeoutMs);
  if (action.type === "assign-relations") return rollbackRelations(action, env, timeoutMs);
  return rollbackDataValues(action, env, timeoutMs);
}

async function rollbackCreate(action: CreateEntityAction, env: ResolvedEnvironment, timeoutMs: number): Promise<boolean> {
  const remove = action.remove ?? {
    path: `${action.resource}/delete/{id}`,
    method: action.deleteMethod,
    idField: "id",
    idPlacement: "path" as const
  };
  const relativePath = remove.idPlacement === "path"
    ? remove.path.replace("{id}", encodeURIComponent(action.entityId))
    : remove.path;
  const path = `${gateway(action.service)}/${relativePath}`;
  const values = { [remove.idField]: action.entityId };
  assertRollbackActionTenantScope(action, env);
  const current = await findEntity(action, env, timeoutMs);
  if (current === null) return false;
  await call(
    env,
    timeoutMs,
    remove.method,
    path,
    remove.idPlacement === "body" ? values : undefined,
    remove.idPlacement === "query" ? { [remove.idField]: [action.entityId] } : undefined
  );
  if ((await findEntity(action, env, timeoutMs)) !== null) {
    throw new CliError(`回滚后回查失败：${action.resource}/${action.entityId} 仍然存在`);
  }
  return true;
}

async function rollbackDelete(action: DeleteEntityAction, env: ResolvedEnvironment, timeoutMs: number): Promise<boolean> {
  assertRollbackActionTenantScope(action, env);
  const current = await findEntity(action, env, timeoutMs);
  if (current !== null) {
    if (matchesSnapshot(current, action.expected)) return false;
    throw new CliError(`删除回滚前记录已被修改：${action.resource}/${action.entityId}`);
  }
  await call(env, timeoutMs, action.restore.method, `${gateway(action.service)}/${action.restore.path}`, action.expected);
  if ((await findEntity(action, env, timeoutMs)) === null) {
    throw new CliError(`删除回滚后回查失败：${action.resource}/${action.entityId} 未恢复`);
  }
  return true;
}

function assertRollbackActionTenantScope(action: OperationAction, env: ResolvedEnvironment): void {
  if ((action.type === "create-entity" || action.type === "delete-entity") && action.tenantPolicy) {
    if (action.tenantPolicy === "any") {
      if (!env.config.tenantCode) {
        throw new CliError(`环境 ${env.name} 未记录 tenantCode，请重新执行 env add 验证 Token`);
      }
      return;
    }
    assertTenantScope(env.config.tenantCode, action.tenantPolicy, env.name);
    return;
  }
  const path = action.type === "create-entity" || action.type === "delete-entity"
    ? `${gateway(action.service)}/${action.resource}/delete/${encodeURIComponent(action.entityId)}`
    : `${gateway(action.service)}/${action.resource}`;
  assertPathTenantScope(env.config.tenantCode, path, env.name);
}

async function rollbackRelations(action: AssignRelationsAction, env: ResolvedEnvironment, timeoutMs: number): Promise<boolean> {
  const base = `${gateway(action.service)}/${action.resource}`;
  assertPathTenantScope(env.config.tenantCode, base, env.name);
  const ids = new Set((await getChildren(action, env, timeoutMs)).map((item) => item.id).filter(isString));
  const removable = action.childIds.filter((id) => ids.has(id));
  if (!removable.length) return false;
  await call(env, timeoutMs, "DELETE", `${base}/removeRelations`, { parentId: action.parentId, childIds: removable });
  const after = new Set((await getChildren(action, env, timeoutMs)).map((item) => item.id));
  if (removable.some((id) => after.has(id))) throw new CliError(`关系回滚后回查失败：${action.resource}`);
  return true;
}

async function rollbackDataValues(action: AssignDataValuesAction, env: ResolvedEnvironment, timeoutMs: number): Promise<boolean> {
  const base = `${gateway(action.service)}/${action.resource}`;
  assertPathTenantScope(env.config.tenantCode, base, env.name);
  const ids = new Set((await getDataValues(action, env, timeoutMs)).map((item) => item.id).filter(isString));
  const removable = action.entityIds.filter((id) => ids.has(id));
  if (!removable.length) return false;
  const suffix = action.parentEntityId ? "removeRelationsByParentEntityId" : "removeRelations";
  await call(env, timeoutMs, "POST", `${base}/${suffix}`, {
    dataRoleId: action.dataRoleId, dataAuthorizeTypeId: action.dataAuthorizeTypeId, entityIds: removable,
    ...(action.parentEntityId ? { parentEntityId: action.parentEntityId } : {})
  });
  const after = new Set((await getDataValues(action, env, timeoutMs)).map((item) => item.id));
  if (removable.some((id) => after.has(id))) throw new CliError("数据权限回滚后回查失败");
  return true;
}

async function findEntity(
  action: Pick<CreateEntityAction | DeleteEntityAction, "service" | "resource" | "entityId" | "lookup">,
  env: ResolvedEnvironment,
  timeoutMs: number
): Promise<RecordValue | null> {
  const legacyPath = `${action.resource}/${action.resource === "serialNumberConfig" ? "getDetail" : "findOne"}`;
  const lookup = action.lookup ?? {
    path: legacyPath,
    method: "GET" as const,
    idField: "id",
    idPlacement: "query" as const
  };
  const values = { [lookup.idField]: action.entityId };
  const data = await call(
    env,
    timeoutMs,
    lookup.method,
    `${gateway(action.service)}/${lookup.path}`,
    lookup.idPlacement === "body" ? values : undefined,
    lookup.idPlacement === "query" ? { [lookup.idField]: [action.entityId] } : undefined
  );
  if (data === null || data === undefined) return null;
  if (!isRecord(data)) throw new CliError(`${action.resource} 回查返回格式无效`);
  return data;
}

function matchesSnapshot(current: RecordValue, expected: RecordValue): boolean {
  return Object.entries(expected).every(([field, value]) =>
    JSON.stringify(current[field] ?? null) === JSON.stringify(value ?? null)
  );
}

async function getChildren(action: AssignRelationsAction, env: ResolvedEnvironment, timeoutMs: number): Promise<RecordValue[]> {
  const data = await call(env, timeoutMs, "GET", `${gateway(action.service)}/${action.resource}/getChildrenFromParentId`,
    undefined, { parentId: [action.parentId] });
  if (!Array.isArray(data)) throw new CliError(`${action.resource} 回查返回格式无效`);
  return data.filter(isRecord);
}

async function getDataValues(action: AssignDataValuesAction, env: ResolvedEnvironment, timeoutMs: number): Promise<RecordValue[]> {
  const suffix = action.parentEntityId ? "getAssignedAuthDataByParentEntityId" : "getAssignedAuthDatas";
  const data = await call(env, timeoutMs, "GET", `${gateway(action.service)}/${action.resource}/${suffix}`, undefined, {
    roleId: [action.dataRoleId], authTypeId: [action.dataAuthorizeTypeId],
    ...(action.parentEntityId ? { parentEntityId: [action.parentEntityId] } : {})
  });
  if (!Array.isArray(data)) throw new CliError("数据权限回查返回格式无效");
  return data.filter(isRecord);
}

async function call(env: ResolvedEnvironment, timeoutMs: number, method: string, path: string,
  body?: unknown, query?: Record<string, string[]>): Promise<unknown> {
  const response = await sendRequest({ baseUrl: env.config.baseUrl, token: env.token, authorization: env.authorization, method, path, timeoutMs,
    ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const envelope = response.data;
  if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
    throw new CliError(`回滚接口返回格式无效：${path}`);
  }
  return envelope.data;
}

function gateway(service: string): string { return `/api-gateway/${service}`; }
function result(record: OperationRecord, rolledBack: number, alreadyAbsent: number, verified: boolean): Record<string, unknown> {
  return { kind: "eadp.rollback.v1", operationId: record.id, environment: record.environment,
    command: record.command, status: record.status, rolledBack, alreadyAbsent, verified };
}
async function save(record: OperationRecord, store: OperationLogStore): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await store.save(record);
}
function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
