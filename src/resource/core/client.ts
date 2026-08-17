import { CliError } from "../../errors.js";
import { sendRequest } from "../../http/client.js";
import {
  EADP_PAGE_SIZE,
  iteratePages,
  parseEadpPage
} from "../../http/pagination.js";
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
    private readonly options: ResourceClientOptions,
    private readonly findAllOverlays: ReadonlyMap<string, ResourceRecord[]> = new Map()
  ) {}

  /** Reuse the same environment credentials for another declared service. */
  forService(service: string): ResourceClient {
    return new ResourceClient({ ...this.options, service }, this.findAllOverlays);
  }

  /** Add an in-memory dependency snapshot for one planning pass only. */
  withFindAllOverlay(resource: string, rows: ResourceRecord[]): ResourceClient {
    const overlays = new Map(this.findAllOverlays);
    overlays.set(resource, rows.map((row) => ({ ...row })));
    return new ResourceClient(this.options, overlays);
  }

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
    if (pagination.pageSize !== EADP_PAGE_SIZE || pagination.startPage !== 1) {
      throw new CliError(`资源契约 ${contract.id} 的 EADP 分页必须从第 1 页开始且每页 500 条`);
    }
    const rows: ResourceRecord[] = [];
    for await (const pageRows of iteratePages({
      endpoint: contract.query.path,
      rowsField: pagination.rowsField,
      isItem: isRecord,
      fetchPage: ({ page, rows: pageSize }) => this.requestContract(contract, contract.query, {
        [pagination.pageField]: {
          [pagination.pageNumberField]: page,
          [pagination.pageSizeField]: pageSize
        },
        filters: options.filters ?? [],
        sortOrders: [],
        ...(options.quickSearchValue === undefined
          ? {}
          : { quickSearchValue: options.quickSearchValue }),
        ...(options.quickSearchProperties === undefined
          ? {}
          : { quickSearchProperties: options.quickSearchProperties })
      })
    })) {
      rows.push(...pageRows);
    }
    return rows;
  }

  /**
   * Read only the total record count for a paged contract (first page only) or
   * the filtered list length for findAll/tree contracts. Keeps "how many"
   * questions on one round trip instead of aggregating every page.
   */
  async countContract(
    contract: ResourceContract,
    options: ContractQueryOptions = {}
  ): Promise<{ count: number; summaryInfo: unknown }> {
    if (contract.read === "findAll" || contract.read === "tree") {
      const rows = await this.queryContract(contract, options);
      return { count: rows.length, summaryInfo: null };
    }
    if (contract.read === "handler") {
      throw new CliError(`资源 ${contract.id} 需要专用查询处理器`);
    }
    const pagination = contract.pagination;
    if (!pagination) {
      throw new CliError(`资源契约 ${contract.id} 缺少分页定义`);
    }
    if (pagination.pageSize !== EADP_PAGE_SIZE || pagination.startPage !== 1) {
      throw new CliError(`资源契约 ${contract.id} 的 EADP 分页必须从第 1 页开始且每页 500 条`);
    }
    const data = await this.requestContract(contract, contract.query, {
      [pagination.pageField]: {
        [pagination.pageNumberField]: 1,
        [pagination.pageSizeField]: EADP_PAGE_SIZE
      },
      filters: options.filters ?? [],
      sortOrders: [],
      ...(options.quickSearchValue === undefined
        ? {}
        : { quickSearchValue: options.quickSearchValue }),
      ...(options.quickSearchProperties === undefined
        ? {}
        : { quickSearchProperties: options.quickSearchProperties })
    });
    const page = parseEadpPage(data, contract.query.path, isRecord, pagination.rowsField);
    return { count: page.records, summaryInfo: page.summaryInfo };
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

  /** Execute the explicitly declared target-only deletion endpoint. */
  async deleteContract(
    contract: ResourceContract,
    entityId: string
  ): Promise<void> {
    const deletion = contract.deletion;
    if (!deletion) throw new CliError(`资源 ${contract.id} 未声明删除契约`);
    const values = { [deletion.remove.idField]: entityId };
    const path = deletion.remove.idPlacement === "path"
      ? deletion.remove.path.replace("{id}", encodeURIComponent(entityId))
      : deletion.remove.path;
    await this.requestContract(
      contract,
      { path, method: deletion.remove.method },
      deletion.remove.idPlacement === "body" ? values : undefined,
      deletion.remove.idPlacement === "query" ? { [deletion.remove.idField]: [entityId] } : undefined
    );
    this.findAllCache.clear();
  }

  /** Read one record through the deletion contract's explicit lookup. */
  async lookupContract(
    contract: ResourceContract,
    entityId: string
  ): Promise<ResourceRecord | null> {
    const deletion = contract.deletion;
    if (!deletion) throw new CliError(`资源 ${contract.id} 未声明删除契约`);
    const values = { [deletion.lookup.idField]: entityId };
    const data = await this.requestContract(
      contract,
      deletion.lookup,
      deletion.lookup.idPlacement === "body" ? values : undefined,
      deletion.lookup.idPlacement === "query" ? { [deletion.lookup.idField]: [entityId] } : undefined
    );
    if (data === null || data === undefined) return null;
    if (!isRecord(data)) throw new CliError(`${deletion.lookup.path} 返回格式无效`);
    return data;
  }

  /** Restore a deleted snapshot through the deletion contract. */
  async restoreContract(
    contract: ResourceContract,
    payload: ResourceRecord
  ): Promise<ResourceRecord> {
    const deletion = contract.deletion;
    if (!deletion) throw new CliError(`资源 ${contract.id} 未声明删除契约`);
    const data = await this.requestContract(contract, deletion.restore, payload);
    if (!isRecord(data) || (typeof data.id !== "string" && typeof data.id !== "number")) {
      throw new CliError(`${deletion.restore.path} 未返回有效 ID`);
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
    const overlay = this.findAllOverlays.get(resource);
    if (overlay) return overlay.map((row) => ({ ...row }));
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

  /** Read one Basic resource by its backend-supported business code. */
  async findByCode(resource: string, code: string): Promise<ResourceRecord | null> {
    const data = await this.call(
      `${resource}/findByCode`,
      "GET",
      undefined,
      { code: [code] }
    );
    if (data === null || data === undefined) return null;
    if (!isRecord(data)) {
      throw new CliError(`${resource}/findByCode 返回格式无效`);
    }
    return data;
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

  async getChildren(
    resource: "conEntityPage" | "conEntityInterface",
    parentId: string
  ): Promise<ResourceRecord[]> {
    const data = await this.call(
      `${resource}/getChildrenFromParentId`,
      "GET",
      undefined,
      { parentId: [parentId] }
    );
    if (!Array.isArray(data)) {
      throw new CliError(`${resource}/getChildrenFromParentId 返回格式无效`);
    }
    return data.filter(isRecord);
  }

  async insertRelations(
    resource: "conEntityPage" | "conEntityInterface",
    parentId: string,
    childIds: string[]
  ): Promise<void> {
    if (childIds.length === 0) return;
    await this.call(`${resource}/insertRelations`, "POST", { parentId, childIds });
  }

  private async call(
    path: string,
    method: string,
    body?: unknown,
    query?: Record<string, string[]>
  ): Promise<unknown> {
    const result = await sendRequest({
      baseUrl: this.options.baseUrl,
      token: this.options.token,
      authorization: this.options.authorization,
      method,
      path: `/api-gateway/${this.options.service}/${path}`,
      ...(body === undefined ? {} : { body }),
      ...(query === undefined ? {} : { query }),
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
    body?: unknown,
    query?: Record<string, string[]>
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
      ...(query === undefined ? {} : { query }),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs })
    });
    const envelope = result.data;
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new CliError(`资源接口返回格式无效：${endpoint.path}`);
    }
    return envelope.data;
  }
}

/** Validate one EADP page for callers that need the legacy completion helper. */
export function shouldFinishContractPagination(
  pagination: NonNullable<ResourceContract["pagination"]>,
  responseData: unknown,
  pageRowCount: number,
  accumulatedRowCount: number,
  pageNumber: number
): boolean {
  if (pagination.pageSize !== EADP_PAGE_SIZE || pagination.startPage !== 1) {
    throw new CliError("资源 EADP 分页必须从第 1 页开始且每页 500 条");
  }
  const page = parseEadpPage(responseData, "资源分页", isRecord, pagination.rowsField);
  if (page.page !== pageNumber || page.rows.length !== pageRowCount) {
    throw new CliError("资源分页响应 page 或 rows 与请求不一致");
  }
  if (accumulatedRowCount > page.records) {
    throw new CliError("资源分页响应 records 小于已读取记录数");
  }
  if (page.total === 0) {
    if (pageNumber !== 1 || page.records !== 0 || page.rows.length !== 0) {
      throw new CliError("资源分页响应空页结构不一致");
    }
    return true;
  }
  const expectedTotal = Math.ceil(page.records / EADP_PAGE_SIZE);
  if (page.total !== expectedTotal) {
    throw new CliError(`资源分页响应 total 页数与 records=${page.records} 不一致`);
  }
  if (pageNumber > page.total) {
    throw new CliError("资源分页响应页码超过 total 页数");
  }
  if (pageNumber < page.total && page.rows.length !== EADP_PAGE_SIZE) {
    throw new CliError(`资源分页提前结束：已读取第 ${pageNumber}/${page.total} 页`);
  }
  if (pageNumber === page.total && accumulatedRowCount !== page.records) {
    throw new CliError(`资源分页记录不完整：已读取 ${accumulatedRowCount}/${page.records} 条`);
  }
  return pageNumber === page.total;
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
