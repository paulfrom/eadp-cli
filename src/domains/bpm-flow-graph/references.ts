import { CliError } from "../../errors.js";
import type { ResourceClient, ResourceRecord } from "../../resource/core/client.js";

/**
 * Environment-scoped BPM graph references. Every lookup is cached per
 * ResourceClient so one compare/sync pass reads each collection (or each
 * requested batch of IDs/codes) at most once.
 */
export interface BpmGraphReferences {
  flowTypes(): Promise<ResourceRecord[]>;
  businessEntities(): Promise<ResourceRecord[]>;
  flowDefinitions(): Promise<ResourceRecord[]>;
  pages(): Promise<ResourceRecord[]>;
  interfaces(): Promise<ResourceRecord[]>;
  organizations(): Promise<ResourceRecord[]>;
  positionCategories(): Promise<ResourceRecord[]>;
  dimensions(): Promise<ResourceRecord[]>;
  /** Condition properties one business entity publishes for gateway decisions. */
  conditionProperties(businessEntityCode: string): Promise<ResourceRecord[]>;
  employeesByIds(ids: readonly string[]): Promise<ResourceRecord[]>;
  employeesByCodes(codes: readonly string[]): Promise<ResourceRecord[]>;
  positionsByIds(ids: readonly string[]): Promise<ResourceRecord[]>;
  positionsByCodes(codes: readonly string[]): Promise<ResourceRecord[]>;
  /** Drop the cached definition list after a create/update writes a new draft. */
  invalidateFlowDefinitions(): void;
}

const referencesByClient = new WeakMap<ResourceClient, BpmGraphReferencesImpl>();

/** Reuse one cache per resolved environment client. */
export function graphReferences(client: ResourceClient): BpmGraphReferences {
  const cached = referencesByClient.get(client);
  if (cached) return cached;
  const created = new BpmGraphReferencesImpl(client);
  referencesByClient.set(client, created);
  return created;
}

class BpmGraphReferencesImpl implements BpmGraphReferences {
  private readonly basicClient: ResourceClient;
  private readonly collections = new Map<string, Promise<ResourceRecord[]>>();
  private readonly employeeById = new Map<string, ResourceRecord>();
  private readonly employeeByCode = new Map<string, ResourceRecord[]>();
  private readonly loadedEmployeeIds = new Set<string>();
  private readonly loadedEmployeeCodes = new Set<string>();
  private readonly positionById = new Map<string, ResourceRecord>();
  private readonly positionByCode = new Map<string, ResourceRecord[]>();
  private readonly loadedPositionIds = new Set<string>();
  private readonly loadedPositionCodes = new Set<string>();

  constructor(private readonly client: ResourceClient) {
    this.basicClient = client.forService("sei-basic");
  }

  flowTypes(): Promise<ResourceRecord[]> {
    return this.collection("conFlowType");
  }

  businessEntities(): Promise<ResourceRecord[]> {
    return this.collection("conBusinessEntity");
  }

  flowDefinitions(): Promise<ResourceRecord[]> {
    return this.collection("defFlowDefinition");
  }

  pages(): Promise<ResourceRecord[]> {
    return this.collection("conPage");
  }

  interfaces(): Promise<ResourceRecord[]> {
    return this.collection("conInterface");
  }

  organizations(): Promise<ResourceRecord[]> {
    return this.cached("conBasicInterface/getAllOrg", async () => {
      const data = await this.client.invoke("conBasicInterface/getAllOrg", "POST");
      return flattenOrganizations(data);
    });
  }

  positionCategories(): Promise<ResourceRecord[]> {
    return this.cached("conBasicInterface/getListPositionCategory", async () => {
      // The endpoint only accepts a JSON body; a bodyless POST is rejected
      // with HttpMediaTypeNotSupportedException before the handler runs.
      const data = await this.client.invoke(
        "conBasicInterface/getListPositionCategory",
        "POST",
        {}
      );
      return recordArray(data, "conBasicInterface/getListPositionCategory");
    });
  }

  conditionProperties(businessEntityCode: string): Promise<ResourceRecord[]> {
    const code = businessEntityCode.trim();
    if (code === "") return Promise.resolve([]);
    return this.cached(
      `conBusinessEntity/getConditionPropertiesExplain?businessEntityCode=${code}`,
      async () => {
        const data = await this.client.invoke(
          "conBusinessEntity/getConditionPropertiesExplain",
          "GET",
          undefined,
          { businessEntityCode: [code] }
        );
        return recordArray(data, "conBusinessEntity/getConditionPropertiesExplain");
      }
    );
  }

  dimensions(): Promise<ResourceRecord[]> {
    return this.cached("conBasicInterface/getAllOrgDimension", async () => {
      const data = await this.client.invoke("conBasicInterface/getAllOrgDimension", "GET");
      return recordArray(data, "conBasicInterface/getAllOrgDimension");
    });
  }

  async employeesByIds(ids: readonly string[]): Promise<ResourceRecord[]> {
    const wanted = uniqueText(ids);
    const missing = wanted.filter((id) => !this.loadedEmployeeIds.has(id));
    if (missing.length > 0) {
      const page = await this.basicClient.findByPage("employee", {
        filters: [{ fieldName: "id", operator: "IN", value: missing }]
      });
      for (const row of page.rows) this.addEmployee(row);
      for (const id of missing) this.loadedEmployeeIds.add(id);
    }
    return wanted
      .map((id) => this.employeeById.get(id))
      .filter((row): row is ResourceRecord => row !== undefined);
  }

  async employeesByCodes(codes: readonly string[]): Promise<ResourceRecord[]> {
    const wanted = uniqueText(codes);
    const missing = wanted.filter((code) => !this.loadedEmployeeCodes.has(code));
    if (missing.length > 0) {
      const page = await this.basicClient.findByPage("employee", {
        filters: [{ fieldName: "code", operator: "IN", value: missing }]
      });
      for (const row of page.rows) this.addEmployee(row);
      for (const code of missing) this.loadedEmployeeCodes.add(code);
    }
    return wanted.flatMap((code) => this.employeeByCode.get(code) ?? []);
  }

  async positionsByIds(ids: readonly string[]): Promise<ResourceRecord[]> {
    const wanted = uniqueText(ids);
    const missing = wanted.filter((id) => !this.loadedPositionIds.has(id));
    if (missing.length > 0) {
      await this.fetchPositions("id", missing);
      for (const id of missing) this.loadedPositionIds.add(id);
    }
    return wanted
      .map((id) => this.positionById.get(id))
      .filter((row): row is ResourceRecord => row !== undefined);
  }

  async positionsByCodes(codes: readonly string[]): Promise<ResourceRecord[]> {
    const wanted = uniqueText(codes);
    const missing = wanted.filter((code) => !this.loadedPositionCodes.has(code));
    if (missing.length > 0) {
      await this.fetchPositions("code", missing);
      for (const code of missing) this.loadedPositionCodes.add(code);
    }
    return wanted.flatMap((code) => this.positionByCode.get(code) ?? []);
  }

  invalidateFlowDefinitions(): void {
    this.collections.delete("defFlowDefinition");
  }

  private collection(resource: string): Promise<ResourceRecord[]> {
    return this.cached(resource, async () => {
      const page = await this.client.findByPage(resource);
      return page.rows;
    });
  }

  private cached(key: string, load: () => Promise<ResourceRecord[]>): Promise<ResourceRecord[]> {
    const existing = this.collections.get(key);
    if (existing) return existing;
    const pending = load();
    this.collections.set(key, pending);
    return pending;
  }

  private async fetchPositions(field: "id" | "code", values: string[]): Promise<void> {
    for (const chunk of chunked(values, 500)) {
      for (let page = 1; ; page += 1) {
        const data = await this.client.invoke(
          "conBasicInterface/getPositionFindByPage",
          "POST",
          {
            pageInfo: { page, rows: 500 },
            filters: [{ fieldName: field, operator: "IN", value: chunk }],
            sortOrders: []
          }
        );
        if (!isRecord(data) || !Array.isArray(data.rows)) {
          throw new CliError("conBasicInterface/getPositionFindByPage 返回格式无效");
        }
        const rows = data.rows.filter(isRecord);
        for (const row of rows) this.addPosition(row);
        const total = typeof data.total === "number" ? data.total : page;
        if (rows.length < 500 || page >= total) break;
      }
    }
  }

  private addEmployee(row: ResourceRecord): void {
    const id = trimmedText(row.id);
    if (!id) return;
    if (!this.employeeById.has(id)) {
      this.employeeById.set(id, row);
      const code = trimmedText(row.code);
      if (code) {
        const rows = this.employeeByCode.get(code) ?? [];
        rows.push(row);
        this.employeeByCode.set(code, rows);
      }
    }
  }

  private addPosition(row: ResourceRecord): void {
    const id = trimmedText(row.id);
    if (!id) return;
    if (!this.positionById.has(id)) {
      this.positionById.set(id, row);
      const code = trimmedText(row.code);
      if (code) {
        const rows = this.positionByCode.get(code) ?? [];
        rows.push(row);
        this.positionByCode.set(code, rows);
      }
    }
  }
}

function flattenOrganizations(value: unknown): ResourceRecord[] {
  if (!Array.isArray(value)) {
    throw new CliError("conBasicInterface/getAllOrg 返回格式无效");
  }
  const result: ResourceRecord[] = [];
  const seen = new Set<string>();
  const visit = (items: unknown[]): void => {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const id = trimmedText(item.id);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      result.push(item);
      if (Array.isArray(item.children)) visit(item.children);
    }
  };
  visit(value);
  return result;
}

function recordArray(value: unknown, path: string): ResourceRecord[] {
  if (!Array.isArray(value)) throw new CliError(`${path} 返回格式无效`);
  return value.filter(isRecord);
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function chunked(values: string[], size: number): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
