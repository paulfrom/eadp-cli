import { CliError } from "../errors.js";

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
  /** Number of rows requested per page. */
  pageSize: number;
  /** Whether the response's `total` has been verified as record count. */
  totalSemantics: "records" | "pages" | "unknown";
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
  deleteMethod: "DELETE" | "POST";
}

/**
 * Declarative contract consumed by query/write/compare/sync.  A contract
 * describes the business semantics in addition to the HTTP endpoints; an
 * endpoint entry alone is deliberately insufficient for registration.
 */
export interface ResourceContract {
  id: string;
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
  selectors?: Array<"code" | "flow">;
  rollback?: ResourceRollbackContract;
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
  const ids = new Set<string>();
  return contracts.map((candidate) => {
    const contract = normalizeContract(candidate);
    if (ids.has(contract.id)) {
      throw new CliError(`资源契约 ID 重复：${contract.id}`);
    }
    ids.add(contract.id);
    if (contract.capabilities.length === 0) {
      throw new CliError(`资源契约 ${contract.id} 未声明能力`);
    }
    if (contract.capabilities.includes("sync") && !contract.capabilities.includes("compare")) {
      throw new CliError(`资源契约 ${contract.id} 声明 sync 能力时必须同时声明 compare`);
    }
    if (contract.adapter && contract.handler) {
      throw new CliError(`资源契约 ${contract.id} 不能同时声明适配器和特殊处理器`);
    }
    if (contract.handler && contract.capabilities.includes("write")) {
      throw new CliError(`资源契约 ${contract.id} 的特殊写操作必须使用领域命令`);
    }
    if (contract.capabilities.includes("write") && !contract.save) {
      throw new CliError(`资源契约 ${contract.id} 声明 write 能力但缺少保存接口`);
    }
    if (contract.capabilities.includes("write") && contract.handler === undefined && !contract.rollback) {
      throw new CliError(`资源契约 ${contract.id} 声明 write 能力但缺少安全回滚契约`);
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
    return contract;
  });
}

export function createResourceRegistry(
  declarations: readonly ResourceContract[]
): ResourceRegistry {
  const contracts = Object.freeze(validateResourceContracts(declarations));
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  return {
    contracts,
    get(id: string): ResourceContract {
      const contract = byId.get(id);
      if (!contract) {
        throw new CliError(
          `资源 ${id} 尚未注册；当前支持：${contracts.map((item) => item.id).join(", ")}`
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
  if (page && (!Number.isInteger(page.pageSize) || page.pageSize <= 0 ||
      !Number.isInteger(page.startPage) || page.startPage < 0 ||
      !page.pageField.trim() || !page.pageNumberField.trim() ||
      !page.pageSizeField.trim() || !page.rowsField.trim())) {
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
  }
  return {
    ...candidate,
    id: candidate.id.trim(),
    identityFields: [...candidate.identityFields],
    compareFields: [...candidate.compareFields],
    writableFields: [...candidate.writableFields],
    capabilities: [...new Set(candidate.capabilities)],
    ...(candidate.selectors ? { selectors: [...new Set(candidate.selectors)] } : {})
  };
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
