import { CliError } from "../../errors.js";
import { sendRequest } from "../../http/client.js";
import { iteratePages } from "../../http/pagination.js";
import type { ResourceContract } from "./contracts.js";

export type ResourceRecord = Record<string, unknown>;

export interface ResourceFilter {
  fieldName: string;
  fieldType?: string;
  operator: string;
  value: unknown;
}

export interface ResourcePage {
  rows: ResourceRecord[];
  total: number;
}

export interface ContractQueryOptions {
  filters?: ResourceFilter[];
  quickSearchValue?: string;
  quickSearchProperties?: string[];
}

export interface ResourceClientOptions {
  baseUrl: string;
  token?: string | undefined;
  authorization?: string | undefined;
  service: string;
  timeoutMs?: number;
}

export class ResourceClient {
  private readonly findAllCache = new Map<string, ResourceRecord[]>();

  constructor(
    private readonly options: ResourceClientOptions
  ) {}

  async findByPage(
    resource: string,
    options: {
      filters?: ResourceFilter[];
      quickSearchValue?: string;
      quickSearchProperties?: string[];
    } = {}
  ): Promise<ResourcePage> {
    const rows: ResourceRecord[] = [];
    for await (const page of this.iterateByPage(resource, options)) {
      rows.push(...page);
    }
    return { rows, total: rows.length };
  }

  /** Read a resource through its declarative contract. */
  async queryContract(
    contract: ResourceContract,
    options: ContractQueryOptions = {}
  ): Promise<ResourceRecord[]> {
    if (contract.read === "findAll") {
      const data = await this.requestContract(contract, contract.query, undefined);
      const rows = extractRows(data);
      return filterRecords(rows, options.filters, options.quickSearchValue);
    }
    if (contract.read === "tree") {
      const data = await this.requestContract(contract, contract.query, undefined);
      const rows = extractRows(data);
      return filterRecords(rows, options.filters, options.quickSearchValue);
    }
    if (contract.read === "handler") {
      throw new CliError(`资源 ${contract.id} 需要专用查询处理器`);
    }
    const pagination = contract.pagination;
    if (!pagination) {
      throw new CliError(`资源契约 ${contract.id} 缺少分页定义`);
    }
    const rows: ResourceRecord[] = [];
    const maxPages = 10_000;
    for (let offset = 0; offset < maxPages; offset += 1) {
      const page = pagination.startPage + offset;
      const body: ResourceRecord = {
        [pagination.pageField]: {
          [pagination.pageNumberField]: page,
          [pagination.pageSizeField]: pagination.pageSize
        },
        filters: options.filters ?? [],
        sortOrders: [],
        ...(options.quickSearchValue === undefined
          ? {}
          : { quickSearchValue: options.quickSearchValue }),
        ...(options.quickSearchProperties === undefined
          ? {}
          : { quickSearchProperties: options.quickSearchProperties })
      };
      const data = await this.requestContract(contract, contract.query, body);
      const pageRows = extractRows(data, pagination.rowsField);
      rows.push(...pageRows);
      if (pageRows.length < pagination.pageSize) return rows;
    }
    throw new CliError(`${contract.query.path} 分页数量异常`);
  }

  /** Save a generic resource. The endpoint and method come from the contract. */
  async saveContract(
    contract: ResourceContract,
    payload: ResourceRecord
  ): Promise<ResourceRecord> {
    if (!contract.save) {
      throw new CliError(`资源 ${contract.id} 未声明保存接口`);
    }
    const data = await this.requestContract(contract, contract.save, payload);
    if (!isRecord(data) || (typeof data.id !== "string" && typeof data.id !== "number")) {
      throw new CliError(`${contract.save.path} 未返回有效 ID`);
    }
    this.findAllCache.clear();
    return data;
  }

  iterateByPage(
    resource: string,
    options: {
      filters?: ResourceFilter[];
      quickSearchValue?: string;
      quickSearchProperties?: string[];
    } = {}
  ): AsyncGenerator<ResourceRecord[]> {
    const endpoint = `${resource}/findByPage`;
    return iteratePages({
      endpoint,
      isItem: isRecord,
      fetchPage: (pageInfo) => this.call(endpoint, "POST", {
        pageInfo,
        filters: options.filters ?? [],
        sortOrders: [],
        ...(options.quickSearchValue === undefined
          ? {}
          : { quickSearchValue: options.quickSearchValue }),
        ...(options.quickSearchProperties === undefined
          ? {}
          : { quickSearchProperties: options.quickSearchProperties })
      })
    });
  }

  async findAll(resource: string): Promise<ResourceRecord[]> {
    const cached = this.findAllCache.get(resource);
    if (cached) {
      return cached;
    }
    const data = await this.call(`${resource}/findAll`, "GET");
    if (!Array.isArray(data)) {
      throw new CliError(`${resource}/findAll 返回格式无效`);
    }
    const records = data.filter(isRecord);
    this.findAllCache.set(resource, records);
    return records;
  }

  async save(resource: string, payload: ResourceRecord): Promise<ResourceRecord> {
    const data = await this.call(`${resource}/save`, "POST", payload);
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new CliError(`${resource}/save 未返回有效 ID`);
    }
    // A prior findAll may have populated a snapshot that no longer reflects
    // the just-written resource.  Invalidate only that resource so post-write
    // verification can observe the server state without affecting unrelated
    // cached collections.
    this.findAllCache.delete(resource);
    return data;
  }

  async getTree(resource: string): Promise<ResourceRecord[]> {
    const data = await this.call(`${resource}/getMenuTree`, "GET");
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new CliError(`${resource}/getMenuTree 返回格式无效`);
    }
    return data;
  }

  async move(resource: string, nodeId: string, targetId: string): Promise<void> {
    await this.call(`${resource}/move`, "POST", {
      nodeId,
      targetId,
      moveType: "ACROSS_LEVEL"
    });
  }

  private async call(path: string, method: string, body?: unknown): Promise<unknown> {
    const result = await sendRequest({
      baseUrl: this.options.baseUrl,
      token: this.options.token,
      authorization: this.options.authorization,
      method,
      path: `/api-gateway/${this.options.service}/${path}`,
      ...(body === undefined ? {} : { body }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs })
    });
    const envelope = result.data;
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new CliError(`资源接口返回格式无效：${path}`);
    }
    return envelope.data;
  }

  private async requestContract(
    contract: ResourceContract,
    endpoint: { path: string; method: string },
    body: unknown
  ): Promise<unknown> {
    const path = endpoint.path.startsWith("/api-gateway/")
      ? endpoint.path
      : `/api-gateway/${contract.service}/${endpoint.path.replace(/^\/+/, "")}`;
    const result = await sendRequest({
      baseUrl: this.options.baseUrl,
      token: this.options.token,
      authorization: this.options.authorization,
      method: endpoint.method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs })
    });
    const envelope = result.data;
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new CliError(`资源接口返回格式无效：${endpoint.path}`);
    }
    return envelope.data;
  }
}

export function createResourceClient(options: ResourceClientOptions): ResourceClient {
  return new ResourceClient(options);
}

export function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRows(value: unknown, rowsField = "rows"): ResourceRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) throw new CliError("资源接口返回格式无效：缺少记录列表");
  const rows = value[rowsField];
  if (Array.isArray(rows)) return rows.filter(isRecord);
  for (const field of ["items", "records", "content", "list", "data"]) {
    const nested = value[field];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  throw new CliError(`资源接口返回格式无效：缺少 ${rowsField}`);
}

const LOCAL_FILTER_OPERATORS = new Set(["EQ", "NE", "LIKE", "GT", "GE", "LT", "LE"]);

/**
 * Apply the public resource filter contract to an already-loaded record list.
 * This is used for findAll-backed resources whose endpoints do not expose the
 * paged filter API.  Quick search intentionally scans every top-level string
 * field so the behavior is independent of a particular resource's schema.
 */
export function filterRecords(
  records: ResourceRecord[],
  filters: ResourceFilter[] = [],
  quickSearchValue?: string
): ResourceRecord[] {
  for (const filter of filters) {
    const operator = filter.operator.toUpperCase();
    if (!LOCAL_FILTER_OPERATORS.has(operator)) {
      throw new CliError(`不支持的过滤操作符：${filter.operator}`);
    }
  }
  const quick = quickSearchValue?.trim().toLocaleLowerCase();
  return records.filter((record) => {
    if (quick && !Object.values(record).some(
      (value) => typeof value === "string" && value.toLocaleLowerCase().includes(quick)
    )) {
      return false;
    }
    return filters.every((filter) =>
      matchRecordFilter(record[filter.fieldName], filter.operator, filter.value)
    );
  });
}

function matchRecordFilter(left: unknown, operator: string, right: unknown): boolean {
  switch (operator.toUpperCase()) {
    case "EQ":
      return sameRecordValue(left, right);
    case "NE":
      return !sameRecordValue(left, right);
    case "LIKE":
      return String(left ?? "").toLocaleLowerCase().includes(
        String(right ?? "").toLocaleLowerCase()
      );
    case "GT":
      return compareRecordValues(left, right) > 0;
    case "GE":
      return compareRecordValues(left, right) >= 0;
    case "LT":
      return compareRecordValues(left, right) < 0;
    case "LE":
      return compareRecordValues(left, right) <= 0;
    default:
      // filterRecords validates operators before evaluating records; this is
      // defensive for callers that invoke the matcher through future paths.
      throw new CliError(`不支持的过滤操作符：${operator}`);
  }
}

function sameRecordValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function compareRecordValues(left: unknown, right: unknown): number {
  const leftNumber = typeof left === "number" ? left : undefined;
  const rightNumber = typeof right === "number" ? right : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber - rightNumber;
  }
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
