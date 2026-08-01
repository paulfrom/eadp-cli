import { CliError } from "../errors.js";
import { sendRequest } from "../http/client.js";

export type ResourceRecord = Record<string, unknown>;

export interface ResourceFilter {
  fieldName: string;
  operator: string;
  value: unknown;
}

export interface ResourcePage {
  rows: ResourceRecord[];
  total: number;
}

export class ResourceClient {
  private readonly findAllCache = new Map<string, ResourceRecord[]>();

  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      service: string;
      timeoutMs?: number;
    }
  ) {}

  async findByPage(
    resource: string,
    options: {
      filters?: ResourceFilter[];
      quickSearchValue?: string;
      quickSearchProperties?: string[];
    } = {}
  ): Promise<ResourcePage> {
    const pageSize = 500;
    const rows: ResourceRecord[] = [];
    let page = 1;
    let total = 0;
    while (true) {
      const data = await this.call(`${resource}/findByPage`, "POST", {
        pageInfo: { page, rows: pageSize },
        filters: options.filters ?? [],
        sortOrders: [],
        ...(options.quickSearchValue === undefined
          ? {}
          : { quickSearchValue: options.quickSearchValue }),
        ...(options.quickSearchProperties === undefined
          ? {}
          : { quickSearchProperties: options.quickSearchProperties })
      });
      if (!isRecord(data) || !Array.isArray(data.rows)) {
        throw new CliError(`${resource}/findByPage 返回格式无效`);
      }
      const pageRows = data.rows.filter(isRecord);
      rows.push(...pageRows);
      total = typeof data.total === "number" ? data.total : rows.length;
      if (rows.length >= total || pageRows.length < pageSize) {
        break;
      }
      page += 1;
      if (page > 10_000) {
        throw new CliError(`${resource}/findByPage 分页数量异常`);
      }
    }
    return { rows, total };
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
    return data;
  }

  private async call(path: string, method: string, body?: unknown): Promise<unknown> {
    const result = await sendRequest({
      baseUrl: this.options.baseUrl,
      token: this.options.token,
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
}

export function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
