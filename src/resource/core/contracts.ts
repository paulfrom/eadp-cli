import { CliError } from "../../errors.js";
import { EADP_PAGE_SIZE } from "../../http/pagination.js";

/** Supported operations exposed by the generic resource command. */
export type ResourceCapability = "query" | "write" | "compare" | "sync";

export type ResourceReadStrategy = "paged" | "findAll" | "tree" | "handler";

export interface ResourceEndpointContract {
  /** Relative path below `/api-gateway/<service>/`. */
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
}

export interface ResourcePaginationContract {
  /** Request body member containing page information. */
  pageField: string;
  /** Page-number member inside pageField. */
  pageNumberField: string;
  /** Page-size member inside pageField. */
  pageSizeField: string;
  /** First page number used by the remote API. */
  startPage: number;
  /** Response member containing records. */
  rowsField: string;
  /** EADP requires exactly 500 rows per request. */
  pageSize: typeof EADP_PAGE_SIZE;
  /** EADP returns `total` as total pages and `records` as total records. */
  totalSemantics: "pages";
}

export interface ResourceTenantContract {
  /** `global` and `non-global` map to the existing tenant scope checks. */
  policy: "any" | "global" | "non-global";
  /** Optional field overwritten with the selected environment tenant. */
  bindField?: string;
}

export interface ResourceDefaultsContract {
  /** Defaults applied only when creating a record. */
  create?: Record<string, unknown>;
  /** Fields that are never copied from the source environment. */
  preserveTargetFields?: string[];
  /** Fields preserved from an existing target only when the source omits them. */
  preserveTargetFieldsWhenMissing?: string[];
}

export interface ResourceFilteringContract {
  /** Whether created-in/from/to may be translated into a source-side time filter. */
  time: boolean;
  /** Contract-declared field used when --time-field is omitted. */
  defaultTimeField?: string;
}

export interface ResourceEnumValue {
  value: string;
  meaning: string;
}

export interface ResourceRollbackContract {
  /** A strictly registered rollback target; arbitrary paths are not accepted. */
  service: string;
  resource: string;
  remove: {
    path: string;
    method: "DELETE" | "POST";
    idField: string;
    idPlacement: "path" | "query" | "body";
  };
  /** Explicit read-back contract used before and after a rollback delete. */
  lookup: {
    path: string;
    method: "GET" | "POST";
    idField: string;
    idPlacement: "query" | "body";
  };
}

/**
 * Explicit target-only deletion semantics. A remove-looking endpoint is not
 * enough to authorize deletion: compare/sync require this complete contract.
 */
export interface ResourceDeletionContract {
  service: string;
  resource: string;
  remove: ResourceRollbackContract["remove"];
  lookup: ResourceRollbackContract["lookup"];
  /** Restore the deleted snapshot during operation rollback. */
  restore: {
    path: string;
    method: "POST" | "PUT" | "PATCH";
  };
}

/**
 * Selector metadata for special compare/sync workflows.  The command layer
 * turns these declarations into options without knowing the domain meaning.
 */
export interface ResourceSelectorContract {
  /** Parsed CLI option name without the leading `--`. */
  name: string;
  /** Value placeholder shown in help, for example `code-or-name`. */
  valuePlaceholder: string;
  /** Human-readable help text for the option. */
  description: string;
  /** Whether this selector must be provided for the resource operation. */
  required: boolean;
}

/**
 * Declarative contract consumed by query/write/compare/sync.  A contract
 * describes the business semantics in addition to the HTTP endpoints; an
 * endpoint entry alone is deliberately insufficient for registration.
 */
export interface ResourceContract {
  id: string;
  /** Alternative CLI names resolving to this canonical resource contract. */
  aliases?: string[];
  title: string;
  description: string;
  service: string;
  query: ResourceEndpointContract;
  save?: ResourceEndpointContract;
  read: ResourceReadStrategy;
  pagination?: ResourcePaginationContract;
  identityFields: string[];
  compareFields: string[];
  writableFields: string[];
  tenant: ResourceTenantContract;
  capabilities: ResourceCapability[];
  help: string;
  defaults?: ResourceDefaultsContract;
  filtering?: ResourceFilteringContract;
  /** Discoverable legal values for top-level or nested request fields. */
  enums?: Record<string, ResourceEnumValue[]>;
  /** Optional record adapter name for dependency mapping/normalization. */
  adapter?: string;
  /** Optional code workflow used instead of the ordinary record engine. */
  handler?: string;
  selectors?: ResourceSelectorContract[];
  rollback?: ResourceRollbackContract;
  /** Resource IDs whose records are planned before this resource. */
  dependencies?: string[];
  /** Explicit contract required before target-only records may be deleted. */
  deletion?: ResourceDeletionContract;
}

export interface ResourceRegistry {
  readonly contracts: readonly ResourceContract[];
  get(id: string): ResourceContract;
  list(): ResourceContract[];
}

/** Validate declarations up-front so a bad resource cannot be half-registered. */
export function validateResourceContracts(
  contracts: readonly ResourceContract[]
): ResourceContract[] {
  const normalized = contracts.map(normalizeContract);
  const ids = new Set<string>();
  for (const contract of normalized) {
    if (ids.has(contract.id)) {
      throw new CliError(`资源契约 ID 重复：${contract.id}`);
    }
    ids.add(contract.id);
  }
  const names = new Map<string, string>();
  for (const contract of normalized) {
    registerResourceName(names, contract.id, contract.id);
    for (const alias of contract.aliases ?? []) {
      registerResourceName(names, alias, contract.id);
    }
  }
  return normalized.map((contract) => {
    if (contract.capabilities.length === 0) {
      throw new CliError(`资源契约 ${contract.id} 未声明能力`);
    }
    if (contract.capabilities.includes("sync") && !contract.capabilities.includes("compare")) {
      throw new CliError(`资源契约 ${contract.id} 声明 sync 能力时必须同时声明 compare`);
    }
    if (contract.adapter && contract.handler) {
      throw new CliError(`资源契约 ${contract.id} 不能同时声明适配器和特殊处理器`);
    }
    if (contract.selectors?.length && !contract.handler) {
      throw new CliError(`资源契约 ${contract.id} 只有特殊处理器才能声明选择器`);
    }
    if (contract.capabilities.includes("write") && contract.handler === undefined && !contract.save) {
      throw new CliError(`资源契约 ${contract.id} 声明 write 能力但缺少保存接口`);
    }
    if (contract.capabilities.includes("write") && contract.handler === undefined && !contract.rollback) {
      throw new CliError(`资源契约 ${contract.id} 声明 write 能力但缺少安全回滚契约`);
    }
    if (contract.capabilities.includes("sync") && contract.handler === undefined && !contract.save) {
      throw new CliError(`资源契约 ${contract.id} 声明 sync 能力但缺少保存接口`);
    }
    if (contract.capabilities.includes("sync") && contract.handler === undefined && !contract.rollback) {
      throw new CliError(`资源契约 ${contract.id} 声明 sync 能力但缺少安全回滚契约`);
    }
    if ((contract.capabilities.includes("compare") || contract.capabilities.includes("sync")) &&
      contract.identityFields.length === 0 && contract.handler === undefined) {
      throw new CliError(`资源契约 ${contract.id} 声明 compare/sync 能力但缺少业务唯一键`);
    }
    if (contract.read === "handler" && !contract.handler) {
      throw new CliError(`资源契约 ${contract.id} 使用专用读取但缺少处理器`);
    }
    if (contract.read === "paged" && !contract.pagination) {
      throw new CliError(`资源契约 ${contract.id} 使用分页读取但缺少分页契约`);
    }
    for (const field of contract.identityFields) {
      if (!contract.compareFields.includes(field) && !contract.writableFields.includes(field)) {
        throw new CliError(`资源契约 ${contract.id} 的业务唯一键字段 ${field} 未列入可比较/可写字段`);
      }
    }
    if (contract.tenant.bindField && !contract.identityFields.includes(contract.tenant.bindField)) {
      throw new CliError(`资源契约 ${contract.id} 的租户绑定字段必须属于业务唯一键`);
    }
    if (contract.dependencies?.includes(contract.id)) {
      throw new CliError(`资源契约 ${contract.id} 不能依赖自身`);
    }
    return contract;
  });
}

export function createResourceRegistry(
  declarations: readonly ResourceContract[]
): ResourceRegistry {
  const contracts = Object.freeze(validateResourceContracts(declarations));
  const byId = new Map<string, ResourceContract>();
  for (const contract of contracts) {
    byId.set(contract.id, contract);
    for (const alias of contract.aliases ?? []) byId.set(alias, contract);
  }
  const canonicalById = new Map(contracts.map((contract) => [contract.id, contract]));
  for (const contract of contracts) {
    for (const dependency of contract.dependencies ?? []) {
      if (!canonicalById.has(dependency)) {
        throw new CliError(`资源契约 ${contract.id} 依赖未注册资源：${dependency}`);
      }
    }
  }
  assertDependencyGraphAcyclic(contracts, byId);
  return {
    contracts,
    get(id: string): ResourceContract {
      const contract = byId.get(id);
      if (!contract) {
        const names = contracts.flatMap((item) => [item.id, ...(item.aliases ?? [])]);
        throw new CliError(
          `资源 ${id} 尚未注册；当前支持：${names.join(", ")}`
        );
      }
      return contract;
    },
    list(): ResourceContract[] {
      return [...contracts].sort((left, right) => left.id.localeCompare(right.id));
    }
  };
}

function normalizeContract(candidate: ResourceContract): ResourceContract {
  if (!/^[a-z][a-z0-9-]*$/.test(candidate.id)) {
    throw new CliError(`资源契约 ID 无效：${candidate.id || "<empty>"}`);
  }
  if (!candidate.title || !candidate.description || !candidate.help) {
    throw new CliError(`资源契约 ${candidate.id} 缺少帮助信息`);
  }
  validatePathSegment(candidate.id, "服务", candidate.service);
  if (candidate.adapter) validatePathSegment(candidate.id, "适配器", candidate.adapter);
  if (candidate.handler) validatePathSegment(candidate.id, "处理器", candidate.handler);
  validateEndpoint(candidate.id, "查询", candidate.query);
  if (candidate.save) {
    validateEndpoint(candidate.id, "保存", candidate.save);
    if (candidate.save.method === "GET") {
      throw new CliError(`资源契约 ${candidate.id} 保存接口不能使用 GET`);
    }
  }
  if (!candidate.writableFields.every((field) => candidate.compareFields.includes(field))) {
    throw new CliError(`资源契约 ${candidate.id} 的可写字段必须属于可比较字段`);
  }
  const page = candidate.pagination;
  if (page && (page.pageSize !== EADP_PAGE_SIZE ||
      !Number.isInteger(page.startPage) || page.startPage < 1 ||
      !page.pageField.trim() || !page.pageNumberField.trim() ||
      !page.pageSizeField.trim() || !page.rowsField.trim() ||
      page.totalSemantics !== "pages")) {
    throw new CliError(`资源契约 ${candidate.id} 的分页契约无效`);
  }
  for (const [name, fields] of [
    ["业务唯一键", candidate.identityFields],
    ["比较", candidate.compareFields],
    ["写入", candidate.writableFields]
  ] as const) {
    if (fields.some((field) => !field.trim()) || new Set(fields).size !== fields.length) {
      throw new CliError(`资源契约 ${candidate.id} 的${name}字段无效或重复`);
    }
  }
  for (const field of Object.keys(candidate.defaults?.create ?? {})) {
    if (!candidate.writableFields.includes(field)) {
      throw new CliError(`资源契约 ${candidate.id} 的新增默认字段 ${field} 不可写`);
    }
  }
  if (candidate.filtering?.time === false && candidate.filtering.defaultTimeField) {
    throw new CliError(`资源契约 ${candidate.id} 不支持时间过滤，不能声明默认时间字段`);
  }
  if (candidate.filtering?.defaultTimeField !== undefined &&
      !candidate.filtering.defaultTimeField.trim()) {
    throw new CliError(`资源契约 ${candidate.id} 的默认时间字段无效`);
  }
  for (const [field, values] of Object.entries(candidate.enums ?? {})) {
    if (!field.trim() || values.length === 0 || values.some((item) => !item.value.trim() || !item.meaning.trim()) ||
        new Set(values.map((item) => item.value)).size !== values.length) {
      throw new CliError(`资源契约 ${candidate.id} 的枚举 ${field} 无效`);
    }
  }
  if (candidate.rollback) {
    validatePathSegment(candidate.id, "回滚服务", candidate.rollback.service);
    validatePathSegment(candidate.id, "回滚资源", candidate.rollback.resource);
    if (candidate.rollback.service !== candidate.service) {
      throw new CliError(`资源契约 ${candidate.id} 的回滚服务必须与资源服务一致`);
    }
    if (!candidate.rollback.lookup) {
      throw new CliError(`资源契约 ${candidate.id} 的安全回滚契约缺少回查接口`);
    }
    validateEndpoint(candidate.id, "回滚回查", candidate.rollback.lookup);
    if (!["GET", "POST"].includes(candidate.rollback.lookup.method) ||
        !["query", "body"].includes(candidate.rollback.lookup.idPlacement) ||
        !isSafeRelativePath(candidate.rollback.lookup.path)) {
      throw new CliError(`资源契约 ${candidate.id} 回滚回查接口无效`);
    }
    validatePathSegment(candidate.id, "回滚 ID 字段", candidate.rollback.lookup.idField);
    validateRollbackRemove(candidate.id, candidate.rollback.remove);
  }
  if (candidate.dependencies !== undefined) {
    if (!Array.isArray(candidate.dependencies) ||
        candidate.dependencies.some((dependency) => !/^[a-z][a-z0-9-]*$/.test(dependency)) ||
        new Set(candidate.dependencies).size !== candidate.dependencies.length) {
      throw new CliError(`资源契约 ${candidate.id} 的依赖声明无效`);
    }
  }
  if (candidate.deletion) {
    validateDeletion(candidate.id, candidate.service, candidate.deletion);
  }
  const selectors = candidate.selectors === undefined
    ? undefined
    : normalizeSelectors(candidate.id, candidate.selectors);
  const aliases = normalizeAliases(candidate.id, candidate.aliases);
  return {
    ...candidate,
    id: candidate.id.trim(),
    ...(aliases === undefined ? {} : { aliases }),
    identityFields: [...candidate.identityFields],
    compareFields: [...candidate.compareFields],
    writableFields: [...candidate.writableFields],
    capabilities: [...new Set(candidate.capabilities)],
    ...(candidate.dependencies === undefined ? {} : { dependencies: [...candidate.dependencies] }),
    ...(selectors === undefined ? {} : { selectors })
  };
}

function normalizeAliases(resourceId: string, aliases: string[] | undefined): string[] | undefined {
  if (aliases === undefined) return undefined;
  if (!Array.isArray(aliases)) {
    throw new CliError(`资源契约 ${resourceId} 的别名声明无效`);
  }
  const names = new Set<string>();
  return aliases.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new CliError(`资源契约 ${resourceId} 的别名声明无效`);
    }
    const alias = candidate.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(alias) || alias === resourceId) {
      throw new CliError(`资源契约 ${resourceId} 的别名无效：${candidate}`);
    }
    if (names.has(alias)) {
      throw new CliError(`资源契约 ${resourceId} 的别名重复：${alias}`);
    }
    names.add(alias);
    return alias;
  });
}

function registerResourceName(names: Map<string, string>, name: string, resourceId: string): void {
  const existing = names.get(name);
  if (existing) {
    throw new CliError(`资源名称或别名重复：${name}（${existing} 与 ${resourceId}）`);
  }
  names.set(name, resourceId);
}

function validateDeletion(
  id: string,
  service: string,
  deletion: ResourceDeletionContract
): void {
  validatePathSegment(id, "删除服务", deletion.service);
  validatePathSegment(id, "删除资源", deletion.resource);
  if (deletion.service !== service) {
    throw new CliError(`资源契约 ${id} 的删除服务必须与资源服务一致`);
  }
  validateRollbackRemove(id, deletion.remove);
  validateEndpoint(id, "删除回查", deletion.lookup);
  if (!["GET", "POST"].includes(deletion.lookup.method) ||
      !["query", "body"].includes(deletion.lookup.idPlacement) ||
      !isSafeRelativePath(deletion.lookup.path)) {
    throw new CliError(`资源契约 ${id} 删除回查接口无效`);
  }
  validatePathSegment(id, "删除回查 ID 字段", deletion.lookup.idField);
  validateEndpoint(id, "删除恢复", deletion.restore);
}

function assertDependencyGraphAcyclic(
  contracts: readonly ResourceContract[],
  byId: ReadonlyMap<string, ResourceContract>
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CliError(`资源契约依赖存在循环：${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const contract of contracts) visit(contract.id);
}

function validateRollbackRemove(
  id: string,
  remove: ResourceRollbackContract["remove"] | undefined
): void {
  if (!remove) throw new CliError(`资源契约 ${id} 的安全回滚契约缺少删除接口`);
  const path = remove.path.trim();
  const validPath = path && !path.startsWith("/") && !path.includes("..") && !/[?#]/.test(path) &&
    path.split("/").every((segment) => segment === "{id}" || isSafePathSegment(segment));
  const idTokens = path.split("{id}").length - 1;
  if (!validPath || !["DELETE", "POST"].includes(remove.method) ||
      !["path", "query", "body"].includes(remove.idPlacement) || !remove.idField.trim() ||
      (remove.idPlacement === "path" ? idTokens !== 1 : idTokens !== 0)) {
    throw new CliError(`资源契约 ${id} 回滚删除接口无效`);
  }
  validatePathSegment(id, "回滚删除 ID 字段", remove.idField);
}

function isSafeRelativePath(path: string): boolean {
  return path.length <= 512 && path.split("/").every(isSafePathSegment);
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function normalizeSelectors(
  resourceId: string,
  selectors: ResourceSelectorContract[]
): ResourceSelectorContract[] {
  if (!Array.isArray(selectors)) {
    throw new CliError(`资源契约 ${resourceId} 的选择器声明无效`);
  }
  const names = new Set<string>();
  return selectors.map((selector) => {
    if (!selector || typeof selector !== "object" ||
        typeof selector.name !== "string" ||
        typeof selector.valuePlaceholder !== "string" ||
        typeof selector.description !== "string") {
      throw new CliError(`资源契约 ${resourceId} 的选择器声明无效`);
    }
    const name = selector.name.trim();
    const valuePlaceholder = selector.valuePlaceholder.trim();
    const description = selector.description.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new CliError(`资源契约 ${resourceId} 的选择器名称无效：${selector.name}`);
    }
    if (names.has(name)) {
      throw new CliError(`资源契约 ${resourceId} 的选择器名称重复：${name}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(valuePlaceholder)) {
      throw new CliError(`资源契约 ${resourceId} 的选择器值占位符无效：${selector.valuePlaceholder}`);
    }
    if (!description || typeof selector.required !== "boolean") {
      throw new CliError(`资源契约 ${resourceId} 的选择器 ${name} 元数据无效`);
    }
    names.add(name);
    return { name, valuePlaceholder, description, required: selector.required };
  });
}

function validatePathSegment(id: string, label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new CliError(`资源契约 ${id} ${label}标识无效`);
  }
}

function validateEndpoint(
  id: string,
  label: string,
  endpoint: ResourceEndpointContract
): void {
  const path = endpoint.path.trim();
  if (!path || path.startsWith("/") || path.includes("..") || /[?#]/.test(path)) {
    throw new CliError(`资源契约 ${id} ${label}路径无效`);
  }
}
