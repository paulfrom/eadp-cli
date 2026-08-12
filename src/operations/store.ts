import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";

export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type ActionStatus = "applied" | "rolled-back" | "not-applied";

interface ActionBase {
  id: string;
  service: "sei-basic" | "sei-bpm";
  resource: string;
  status: ActionStatus;
}

export interface CreateEntityAction extends ActionBase {
  type: "create-entity";
  entityId: string;
  expected: Record<string, unknown>;
  deleteMethod: "DELETE" | "POST";
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

export type OperationAction = CreateEntityAction | AssignRelationsAction | AssignDataValuesAction;

export interface OperationRecord {
  version: 1;
  id: string;
  command: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
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
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(record.id);
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);
  }

  async load(id: string): Promise<OperationRecord> {
    validateId(id);
    try {
      const record = JSON.parse(await readFile(this.pathFor(id), "utf8")) as unknown;
      validateRecord(record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError(`操作日志 ${id} 不存在或已过期`);
      }
      if (error instanceof CliError) throw error;
      throw new CliError(`操作日志 ${id} 格式无效`);
    }
  }

  async cleanup(now = new Date()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = now.getTime() - OPERATION_RETENTION_MS;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(join(this.directory, name), "utf8")) as { createdAt?: unknown };
        const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt) && createdAt <= cutoff) {
          await rm(join(this.directory, name), { force: true });
        }
      } catch {
        // 无法确认创建时间的日志保留，避免误删潜在恢复数据。
      }
    }
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.json`);
  }
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
  validateId((value as OperationRecord).id);
  for (const action of (value as OperationRecord).actions) validateAction(action);
}

const basicEntities = new Set([
  "appModule", "featureRole", "dataRole", "feature", "featureGroup", "menu", "serialNumberConfig"
]);
const bpmEntities = new Set([
  "conBusinessModule", "conBusinessEntity", "conPage", "conInterface", "conFlowType"
]);
const basicRelations = new Set([
  "featureRoleFeature", "userFeatureRole", "userDataRole", "positionFeatureRole",
  "positionDataRole", "positionCategoryFeatureRole"
]);
const bpmRelations = new Set(["conEntityPage", "conEntityInterface"]);

function validateAction(value: unknown): asserts value is OperationAction {
  if (typeof value !== "object" || value === null) throw new CliError("操作日志动作格式无效");
  const action = value as OperationAction;
  if (typeof action.id !== "string" || !["applied", "rolled-back", "not-applied"].includes(action.status)) {
    throw new CliError("操作日志动作格式无效");
  }
  const serviceResources = action.service === "sei-basic"
    ? { entities: basicEntities, relations: basicRelations }
    : action.service === "sei-bpm"
      ? { entities: bpmEntities, relations: bpmRelations }
      : null;
  if (!serviceResources) throw new CliError("操作日志服务无效");
  if (action.type === "create-entity") {
    const validMethod = action.resource === "serialNumberConfig"
      ? action.deleteMethod === "POST"
      : action.deleteMethod === "DELETE";
    if (!serviceResources.entities.has(action.resource) || typeof action.entityId !== "string" ||
        !isRecord(action.expected) || !validMethod) {
      throw new CliError("操作日志新增动作格式无效");
    }
    return;
  }
  if (action.type === "assign-relations") {
    if (!serviceResources.relations.has(action.resource) || typeof action.parentId !== "string" ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
