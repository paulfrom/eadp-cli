import type { ResourceContract } from "../core/contracts.js";

export const featureGroupContract: ResourceContract =   {
    id: "feature-group",
    title: "功能项组",
    description: "查询、创建或更新功能项组；业务唯一键为 code。",
    service: "sei-basic",
    query: { path: "featureGroup/findAll", method: "GET" },
    save: { path: "featureGroup/save", method: "POST" },
    read: "findAll",
    identityFields: ["code"],
    compareFields: ["code", "name", "appModuleId"],
    writableFields: ["code", "name", "appModuleId"],
    tenant: { policy: "global" },
    capabilities: ["query", "write", "compare", "sync"],
    help: "功能项组通过 appModuleCode 适配到目标应用模块；仅允许 global 租户。",
    filtering: { time: true, defaultTimeField: "createdDate" },
    adapter: "feature-group",
    rollback: { service: "sei-basic", resource: "featureGroup", deleteMethod: "DELETE" }
  };
