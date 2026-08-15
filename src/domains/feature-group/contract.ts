import type { ResourceContract } from "../../resource/core/contracts.js";

export const featureGroupContract: ResourceContract =   {
    id: "feature-group",
    title: "功能项组",
    description: "查询、创建或更新功能项组；业务唯一键为 code。",
    service: "sei-basic",
    query: { path: "featureGroup/getAuthorizedFeatureGroup", method: "GET" },
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
    dependencies: ["app-module"],
    rollback: { service: "sei-basic", resource: "featureGroup", remove: { path: "featureGroup/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" }, lookup: { path: "featureGroup/findOne", method: "GET", idField: "id", idPlacement: "query" } },
    deletion: { service: "sei-basic", resource: "featureGroup", remove: { path: "featureGroup/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" }, lookup: { path: "featureGroup/findOne", method: "GET", idField: "id", idPlacement: "query" }, restore: { path: "featureGroup/save", method: "POST" } }
  };
