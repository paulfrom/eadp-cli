import { CliError } from "../errors.js";
import { sendRequest } from "../http/client.js";
import { readAllPages } from "../http/pagination.js";

export interface BpmClientOptions {
  baseUrl: string;
  token?: string | undefined;
  authorization?: string | undefined;
  timeoutMs?: number;
}

export class BpmClient {
  constructor(private readonly options: BpmClientOptions) {}

  async findByPage(resource: string): Promise<Record<string, unknown>[]> {
    const endpoint = `${resource}/findByPage`;
    return readAllPages({
      endpoint,
      isItem: isRecord,
      fetchPage: (pageInfo) => this.call(endpoint, "POST", {
        pageInfo,
        filters: [],
        sortOrders: []
      })
    });
  }

  async save(
    resource: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const data = await this.call(`${resource}/save`, "POST", payload);
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new CliError(`${resource}/save 未返回有效 ID`);
    }
    return data;
  }

  async getChildren(
    resource: "conEntityPage" | "conEntityInterface",
    parentId: string
  ): Promise<Record<string, unknown>[]> {
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
    if (childIds.length === 0) {
      return;
    }
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
      path: `/api-gateway/sei-bpm/${path}`,
      ...(body === undefined ? {} : { body }),
      ...(query === undefined ? {} : { query }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs })
    });
    const envelope = result.data;
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new CliError(`BPM 接口返回格式无效：${path}`);
    }
    return envelope.data;
  }
}

export function stringField(
  value: Record<string, unknown>,
  field: string
): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
