import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "../errors.js";

export const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

type ActionStatus = "applied" | "rolled-back" | "not-applied";

interface ActionBase {
  id: string;
  service: string;
  resource: string;
  status: ActionStatus;
}

export interface CreateEntityAction extends ActionBase {
  type: "create-entity";
  entityId: string;
  expected: Record<string, unknown>;
  deleteMethod: "DELETE" | "POST";
  /** Optional for legacy operation logs; new generic resources always persist it. */
  remove?: {
    path: string;
    method: "DELETE" | "POST";
    idField: string;
    idPlacement: "path" | "query" | "body";
  };
  /** Optional for legacy operation logs; new generic resources always persist it. */
  lookup?: {
    path: string;
    method: "GET" | "POST";
    idField: string;
    idPlacement: "query" | "body";
  };
  tenantPolicy?: "any" | "global" | "non-global";
}

export interface DeleteEntityAction extends ActionBase {
  type: "delete-entity";
  entityId: string;
  /** Snapshot captured before deletion; rollback restores this exact record. */
  expected: Record<string, unknown>;
  remove: {
    path: string;
    method: "DELETE" | "POST";
    idField: string;
    idPlacement: "path" | "query" | "body";
  };
  lookup: {
    path: string;
    method: "GET" | "POST";
    idField: string;
    idPlacement: "query" | "body";
  };
  restore: {
    path: string;
    method: "POST" | "PUT" | "PATCH";
  };
  tenantPolicy?: "any" | "global" | "non-global";
}

export interface AssignRelationsAction extends ActionBase {
  type: "assign-relations";
  parentId: string;
  childIds: string[];
}

export interface AssignDataValuesAction extends ActionBase {
  type: "assign-data-values";
  dataRoleId: string;
  dataAuthorizeTypeId: string;
  entityIds: string[];
  parentEntityId?: string;
}

export type OperationAction = CreateEntityAction | DeleteEntityAction | AssignRelationsAction | AssignDataValuesAction;

export interface OperationRecord {
  version: 1;
  id: string;
  command: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Completion time is absent while an operation is in progress or partial.
   * Batch rollback validates that every selected record has a usable value
   * before doing any writes.
   */
  completedAt?: string;
  status: "in-progress" | "completed" | "partial" | "rolling-back" | "rolled-back" | "rollback-failed";
  actions: OperationAction[];
  error?: string;
}

export class OperationLogStore {
  readonly directory: string;

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, "operations");
  }

  async save(record: OperationRecord): Promise<void> {
    validateRecord(record);
    const date = operationDate(record.createdAt);
    await this.withWriteLock(async () => {
      const path = join(this.directory, `${date}.jsonl`);
      await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(path, 0o600);
    });
  }

  async load(id: string): Promise<OperationRecord> {
    validateId(id);
    let latest: OperationRecord | undefined;
    let latestInvalid = false;

    let names: string[] = [];
    try {
      names = (await readdir(this.directory)).filter((name) => isAggregateName(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const contents = await readFile(join(this.directory, name), "utf8");
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(value) || value.id !== id) continue;
        try {
          validateRecord(value);
          latest = value;
          latestInvalid = false;
        } catch {
          latestInvalid = true;
        }
      }
    }
    if (latestInvalid) throw new CliError(`操作日志 ${id} 格式无效`);
    if (!latest) throw new CliError(`操作日志 ${id} 不存在或已过期`);
    return latest;
  }

  async cleanup(now = new Date()): Promise<void> {
    await this.withWriteLock(async () => {
      const names = await readdir(this.directory);
      const cutoff = now.getTime() - OPERATION_RETENTION_MS;
      for (const name of names) {
        if (!isAggregateName(name)) continue;
        await this.cleanupAggregate(join(this.directory, name), cutoff);
      }
    }, false);
  }

  private async cleanupAggregate(path: string, cutoff: number): Promise<void> {
    const malformed: string[] = [];
    const retained = new Map<string, OperationRecord>();
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        validateRecord(value);
        if (recordTime(value) > cutoff) retained.set(value.id, value);
      } catch {
        // Preserve malformed lines: they may contain recovery information that
        // a future/manual repair can recover, and must not endanger valid rows.
        malformed.push(line);
      }
    }
    const lines = [...malformed, ...[...retained.values()].map((record) => JSON.stringify(record))];
    if (lines.length === 0) {
      await rm(path, { force: true });
      return;
    }
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  }

  private async withWriteLock<T>(action: () => Promise<T>, createDirectory = true): Promise<T> {
    if (createDirectory) await mkdir(this.directory, { recursive: true });
    else {
      try {
        await mkdir(this.directory, { recursive: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined as T;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const lockPath = join(this.directory, ".write.lock");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(25);
      }
    }
    if (!handle) throw new CliError("操作日志正在被其他进程写入，请稍后重试");
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

function isAggregateName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

function operationDate(createdAt: string): string {
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) throw new CliError("操作日志创建时间格式无效");
  return new Date(time).toISOString().slice(0, 10);
}

function recordTime(record: OperationRecord): number {
  const time = Date.parse(record.createdAt);
  if (!Number.isFinite(time)) throw new CliError("操作日志创建时间格式无效");
  return time;
}

function validateId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new CliError(`operation-id 格式无效：${id}`);
  }
}

function validateRecord(value: unknown): asserts value is OperationRecord {
  if (typeof value !== "object" || value === null || (value as OperationRecord).version !== 1 ||
      typeof (value as OperationRecord).id !== "string" || typeof (value as OperationRecord).createdAt !== "string" ||
      !Array.isArray((value as OperationRecord).actions)) {
    throw new CliError("操作日志格式无效");
  }
  if ("completedAt" in value && !isValidCompletedAt((value as OperationRecord).completedAt)) {
    throw new CliError("操作日志完成时间格式无效");
  }
  validateId((value as OperationRecord).id);
  for (const action of (value as OperationRecord).actions) validateAction(action);
}

/** Return true only for a parseable ISO timestamp string. */
export function isValidCompletedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

const basicRelations = new Set([
  "featureRoleFeature", "userFeatureRole", "userDataRole", "positionFeatureRole",
  "positionDataRole", "positionCategoryFeatureRole", "employeePosition"
]);
const bpmRelations = new Set(["conEntityPage", "conEntityInterface"]);

function validateAction(value: unknown): asserts value is OperationAction {
  if (typeof value !== "object" || value === null) throw new CliError("操作日志动作格式无效");
  const action = value as OperationAction;
  if (typeof action.id !== "string" || !["applied", "rolled-back", "not-applied"].includes(action.status)) {
    throw new CliError("操作日志动作格式无效");
  }
  if (!isSafePathSegment(action.service) || !isSafePathSegment(action.resource)) {
    throw new CliError("操作日志服务或资源无效");
  }
  const relationResources = action.service === "sei-basic"
    ? basicRelations
    : action.service === "sei-bpm"
      ? bpmRelations
      : null;
  if (action.type === "create-entity") {
    const validTenantPolicy = action.tenantPolicy === undefined ||
      ["any", "global", "non-global"].includes(action.tenantPolicy);
    if (typeof action.entityId !== "string" || action.entityId.trim() === "" ||
        !isRecord(action.expected) || !["DELETE", "POST"].includes(action.deleteMethod) ||
        !validTenantPolicy || !isValidLookup(action.lookup) || !isValidRemove(action.remove)) {
      throw new CliError("操作日志新增动作格式无效");
    }
    return;
  }
  if (action.type === "delete-entity") {
    const validTenantPolicy = action.tenantPolicy === undefined ||
      ["any", "global", "non-global"].includes(action.tenantPolicy);
    if (typeof action.entityId !== "string" || action.entityId.trim() === "" ||
        !isRecord(action.expected) || !validTenantPolicy ||
        !isValidLookup(action.lookup, true) || !isValidRemove(action.remove, true) ||
        !isValidRestore(action.restore)) {
      throw new CliError("操作日志删除动作格式无效");
    }
    return;
  }
  if (action.type === "assign-relations") {
    if (!relationResources || !relationResources.has(action.resource) || typeof action.parentId !== "string" ||
        !isStringArray(action.childIds)) {
      throw new CliError("操作日志分配动作格式无效");
    }
    return;
  }
  if (action.type !== "assign-data-values" || action.service !== "sei-basic" ||
      action.resource !== "dataRoleAuthTypeValue" || typeof action.dataRoleId !== "string" ||
      typeof action.dataAuthorizeTypeId !== "string" || !isStringArray(action.entityIds) ||
      (action.parentEntityId !== undefined && typeof action.parentEntityId !== "string")) {
    throw new CliError("操作日志数据权限动作格式无效");
  }
}

function isValidLookup(
  value: CreateEntityAction["lookup"] | DeleteEntityAction["lookup"],
  required = false
): boolean {
  if (value === undefined) return !required;
  return isSafeRelativePath(value.path) && ["GET", "POST"].includes(value.method) &&
    isSafePathSegment(value.idField) && ["query", "body"].includes(value.idPlacement);
}

function isValidRemove(
  value: CreateEntityAction["remove"] | DeleteEntityAction["remove"],
  required = false
): boolean {
  if (value === undefined) return !required;
  const idTokens = value.path.split("{id}").length - 1;
  return isSafeTemplatePath(value.path) && ["DELETE", "POST"].includes(value.method) &&
    isSafePathSegment(value.idField) && ["path", "query", "body"].includes(value.idPlacement) &&
    (value.idPlacement === "path" ? idTokens === 1 : idTokens === 0);
}

function isValidRestore(value: unknown): value is DeleteEntityAction["restore"] {
  return isRecord(value) && isSafeRelativePath(value.path) &&
    ["POST", "PUT", "PATCH"].includes(value.method as string);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && value.split("/").every(isSafePathSegment);
}

function isSafeTemplatePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && value.split("/").every(
      (segment) => segment === "{id}" || isSafePathSegment(segment)
    );
}

function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
