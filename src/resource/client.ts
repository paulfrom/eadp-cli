import { CliError } from "../errors.js";
import { sendRequest } from "../http/client.js";
import { iteratePages } from "../http/pagination.js";

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
    const rows: ResourceRecord[] = [];
    for await (const page of this.iterateByPage(resource, options)) {
      rows.push(...page);
    }
    return { rows, total: rows.length };
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
