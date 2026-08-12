import { CliError } from "../errors.js";
import { sendRequest } from "../http/client.js";
import { readAllPages } from "../http/pagination.js";

export interface PermissionClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface PermissionFilter {
  fieldName: string;
  fieldType?: string;
  operator: string;
  value: unknown;
}

export type PermissionRecord = Record<string, unknown>;

export class PermissionClient {
  constructor(private readonly options: PermissionClientOptions) {}

  async findAll(resource: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call(`${resource}/findAll`, "GET"),
      `${resource}/findAll`
    );
  }

  async findByPage(
    resource: string,
    options: { filters?: PermissionFilter[] } = {}
  ): Promise<PermissionRecord[]> {
    const endpoint = `${resource}/findByPage`;
    return readAllPages({
      endpoint,
      isItem: isRecord,
      fetchPage: (pageInfo) => this.call(endpoint, "POST", {
        pageInfo,
        filters: options.filters ?? []
      })
    });
  }

  /**
   * Read the data-role catalog through the endpoints exposed by sei-basic.
   * DataRole does not provide findByPage: roles are returned per role group.
   * The optional groups argument lets callers that already need the group
   * list avoid fetching it twice; without it this method performs findAll.
   */
  async findDataRoles(
    roleGroups?: PermissionRecord[]
  ): Promise<PermissionRecord[]> {
    const groups = roleGroups ?? (await this.findAll("dataRoleGroup"));
    const roles: PermissionRecord[] = [];
    const seenIds = new Set<string>();
    const groupIds: string[] = [];
    for (const group of groups) {
      if (typeof group.id !== "string" || group.id.trim() === "") {
        throw new CliError("数据角色组缺少有效 ID，无法查询数据角色");
      }
      groupIds.push(group.id);
    }
    for (const groupId of groupIds) {
      const groupRoles = this.expectRecordList(
        await this.call("dataRole/findByDataRoleGroup", "GET", undefined, {
          roleGroupId: [groupId]
        }),
        "dataRole/findByDataRoleGroup"
      );
      for (const role of groupRoles) {
        if (typeof role.id === "string" && role.id !== "") {
          if (seenIds.has(role.id)) {
            continue;
          }
          seenIds.add(role.id);
        }
        roles.push(role);
      }
    }
    return roles;
  }

  /**
   * Resolve a feature-group by its business code.  FeatureGroupController
   * exposes findAll rather than a dedicated findByCode route, so matching is
   * performed locally and the result is still checked for duplicate business
   * keys using strict case-insensitive comparison.
   */
  async findFeatureGroupByCode(code: string): Promise<PermissionRecord | null> {
    const rows = await this.findAll("featureGroup");
    const normalized = code.trim().toLocaleLowerCase();
    const matches = rows.filter(
      (record) =>
        typeof record.code === "string" &&
        record.code.trim().toLocaleLowerCase() === normalized
    );
    if (matches.length > 1) {
      throw new CliError(`功能项组 code 不唯一：${code}`);
    }
    return matches[0] ?? null;
  }

  /** Resolve every global application module matching an explicit code. */
  async findAppModulesByCode(code: string): Promise<PermissionRecord[]> {
    // Do not use findAll's cache here: apply feature-group creates a module
    // and immediately re-queries by code to verify the server state.
    const rows = this.expectRecordList(
      await this.call("appModule/findAll", "GET"),
      "appModule/findAll"
    );
    const normalized = code.trim().toLocaleLowerCase();
    return rows.filter(
      (record) =>
        typeof record.code === "string" &&
        record.code.trim().toLocaleLowerCase() === normalized
    );
  }

  async getFeatureTypes(): Promise<unknown[]> {
    return this.expectList(
      await this.call("feature/getFeatureTypes", "GET"),
      "feature/getFeatureTypes"
    );
  }

  async findFeaturesByAppModule(appModuleId: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call("feature/findByAppModuleId", "GET", undefined, {
        appModuleId: [appModuleId]
      }),
      "feature/findByAppModuleId"
    );
  }

  async getMenuTree(): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call("menu/getMenuTree", "GET"),
      "menu/getMenuTree"
    );
  }

  async getRoleMenuFeatureTree(featureRoleId: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call("featureRoleFeature/getMenuFeatureTree", "GET", undefined, {
        featureRoleId: [featureRoleId]
      }),
      "featureRoleFeature/getMenuFeatureTree"
    );
  }

  async getAuthorizedMenuRoots(featureRoleId: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call(
        "featureRoleFeature/getAuthorizedMenuRootNodes",
        "GET",
        undefined,
        { featureRoleId: [featureRoleId] }
      ),
      "featureRoleFeature/getAuthorizedMenuRootNodes"
    );
  }

  async findFeatureRoleByCode(code: string): Promise<PermissionRecord | null> {
    const data = await this.call("featureRole/findByCode", "GET", undefined, {
      code: [code]
    });
    if (data === null || data === undefined) {
      return null;
    }
    if (!isRecord(data)) {
      throw new CliError("featureRole/findByCode 返回格式无效");
    }
    return data;
  }

  async findFeatureByCode(code: string): Promise<PermissionRecord | null> {
    const data = await this.call("feature/findByCode", "GET", undefined, {
      code: [code]
    });
    if (data === null || data === undefined) {
      return null;
    }
    if (!isRecord(data)) {
      throw new CliError("feature/findByCode 返回格式无效");
    }
    return data;
  }

  async save(
    resource: string,
    payload: PermissionRecord
  ): Promise<PermissionRecord> {
    const data = await this.call(`${resource}/save`, "POST", payload);
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new CliError(`${resource}/save 未返回有效 ID`);
    }
    return data;
  }

  async getChildren(
    resource: string,
    parentId: string
  ): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call(`${resource}/getChildrenFromParentId`, "GET", undefined, {
        parentId: [parentId]
      }),
      `${resource}/getChildrenFromParentId`
    );
  }

  async insertRelations(
    resource: string,
    parentId: string,
    childIds: string[]
  ): Promise<void> {
    if (childIds.length === 0) {
      return;
    }
    await this.call(`${resource}/insertRelations`, "POST", {
      parentId,
      childIds
    });
  }

  async removeRelations(
    resource: string,
    parentId: string,
    childIds: string[]
  ): Promise<void> {
    if (childIds.length === 0) {
      return;
    }
    await this.call(`${resource}/removeRelations`, "DELETE", {
      parentId,
      childIds
    });
  }

  async findEmployeeByCode(code: string): Promise<PermissionRecord | null> {
    const data = await this.call("employee/findByCode", "GET", undefined, {
      code: [code]
    });
    if (data === null || data === undefined) {
      return null;
    }
    if (!isRecord(data)) {
      throw new CliError("employee/findByCode 返回格式无效");
    }
    return data;
  }

  async quickSearchEmployees(value: string): Promise<PermissionRecord[]> {
    const data = await this.call("employee/quickSearch", "POST", {
      quickSearchValue: value,
      pageInfo: { page: 1, rows: 100 },
      filters: [],
      sortOrders: []
    });
    if (!isRecord(data) || !Array.isArray(data.rows)) {
      throw new CliError("employee/quickSearch 返回格式无效");
    }
    return data.rows.filter(isRecord);
  }

  async getAssignedDataValues(options: {
    dataRoleId: string;
    dataAuthorizeTypeId: string;
    parentEntityId?: string;
  }): Promise<PermissionRecord[]> {
    const path = options.parentEntityId
      ? "dataRoleAuthTypeValue/getAssignedAuthDataByParentEntityId"
      : "dataRoleAuthTypeValue/getAssignedAuthDatas";
    return this.expectRecordList(
      await this.call(path, "GET", undefined, {
        roleId: [options.dataRoleId],
        authTypeId: [options.dataAuthorizeTypeId],
        ...(options.parentEntityId === undefined
          ? {}
          : { parentEntityId: [options.parentEntityId] })
      }),
      path
    );
  }

  async insertDataValues(options: {
    dataRoleId: string;
    dataAuthorizeTypeId: string;
    entityIds: string[];
    parentEntityId?: string;
  }): Promise<void> {
    if (options.entityIds.length === 0) {
      return;
    }
    const path = options.parentEntityId
      ? "dataRoleAuthTypeValue/insertRelationsByParentEntityId"
      : "dataRoleAuthTypeValue/insertRelations";
    await this.call(path, "POST", {
      dataRoleId: options.dataRoleId,
      dataAuthorizeTypeId: options.dataAuthorizeTypeId,
      entityIds: options.entityIds,
      ...(options.parentEntityId === undefined
        ? {}
        : { parentEntityId: options.parentEntityId })
    });
  }

  async getRoleAuthorizationTypes(dataRoleId: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call(
        "dataRoleAuthTypeValue/getAuthorizeTypesByRoleId",
        "GET",
        undefined,
        { roleId: [dataRoleId] }
      ),
      "dataRoleAuthTypeValue/getAuthorizeTypesByRoleId"
    );
  }

  async getFeatureRolesByAccount(account: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call("user/getFeatureRolesByAccount", "GET", undefined, {
        account: [account],
        includeProject: ["true"]
      }),
      "user/getFeatureRolesByAccount"
    );
  }

  async getDataRolesByAccount(account: string): Promise<PermissionRecord[]> {
    return this.expectRecordList(
      await this.call("user/getDataRolesByAccount", "GET", undefined, {
        account: [account],
        includeProject: ["true"]
      }),
      "user/getDataRolesByAccount"
    );
  }

  async checkUserFeatures(
    userId: string,
    featureCodes: string[]
  ): Promise<Record<string, boolean>> {
    const data = await this.call("user/checkUserFeaturesAuthority", "POST", {
      userId,
      featureCodes
    });
    if (!isRecord(data)) {
      throw new CliError("user/checkUserFeaturesAuthority 返回格式无效");
    }
    return Object.fromEntries(
      Object.entries(data).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
      )
    );
  }

  async findUsers(): Promise<PermissionRecord[]> {
    return this.findByPage("user");
  }

  async getAuthorizedEntityIds(options: {
    userId: string;
    entityClassName: string;
    featureCode?: string;
    parentEntityId?: string;
  }): Promise<string[]> {
    const data = await this.call(
      "user/getNormalUserAuthorizedEntities",
      "GET",
      undefined,
      {
        userId: [options.userId],
        entityClassName: [options.entityClassName],
        featureCode: [options.featureCode ?? ""],
        parentEntityId: [options.parentEntityId ?? "none"]
      }
    );
    if (!Array.isArray(data) || !data.every((item) => typeof item === "string")) {
      throw new CliError("user/getNormalUserAuthorizedEntities 返回格式无效");
    }
    return data;
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
      method,
      path: `/api-gateway/sei-basic/${path}`,
      ...(body === undefined ? {} : { body }),
      ...(query === undefined ? {} : { query }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs })
    });
    const envelope = result.data;
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new CliError(`权限接口返回格式无效：${path}`);
    }
    return envelope.data;
  }

  private expectList(data: unknown, path: string): unknown[] {
    if (!Array.isArray(data)) {
      throw new CliError(`${path} 返回格式无效`);
    }
    return data;
  }

  private expectRecordList(data: unknown, path: string): PermissionRecord[] {
    return this.expectList(data, path).filter(isRecord);
  }
}

export function isRecord(value: unknown): value is PermissionRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
