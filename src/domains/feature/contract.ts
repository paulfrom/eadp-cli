import type { ResourceContract } from "../../resource/core/contracts.js";

export const featureContract: ResourceContract =   {
    id: "feature",
    title: "功能项",
    description: "查询、创建或更新功能项；业务唯一键为 code。",
    service: "sei-basic",
    query: { path: "feature/findByPage", method: "POST" },
    save: { path: "feature/save", method: "POST" },
    read: "paged",
    pagination: {
      pageField: "pageInfo",
      pageNumberField: "page",
      pageSizeField: "rows",
      startPage: 1,
      rowsField: "rows",
      pageSize: 500,
      totalSemantics: "unknown"
    },
    identityFields: ["code"],
    compareFields: [
      "code", "name", "groupCode", "url", "canMenu", "featureType", "appModuleId",
      "featureGroupId", "tenantCanUse", "mobileUse"
    ],
    writableFields: [
      "code", "name", "groupCode", "url", "canMenu", "featureType", "appModuleId",
      "featureGroupId", "tenantCanUse", "mobileUse"
    ],
    tenant: { policy: "global" },
    capabilities: ["query", "write", "compare", "sync"],
    help: "功能项通过 appModuleCode/featureGroupCode 解析目标依赖；仅允许 global 租户。",
    defaults: {
      create: { tenantCanUse: true },
      preserveTargetFieldsWhenMissing: ["tenantCanUse"]
    },
    filtering: { time: true, defaultTimeField: "createdDate" },
    adapter: "feature",
    rollback: { service: "sei-basic", resource: "feature", remove: { path: "feature/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" }, lookup: { path: "feature/findOne", method: "GET", idField: "id", idPlacement: "query" } }
  };
