import type { ResourceContract } from "../core/contracts.js";

export const appModuleContract: ResourceContract =   {
    id: "app-module",
    title: "应用模块",
    description: "查询、创建或更新应用模块；业务唯一键为 code。",
    service: "sei-basic",
    query: { path: "appModule/findAll", method: "GET" },
    save: { path: "appModule/save", method: "POST" },
    read: "findAll",
    identityFields: ["code"],
    compareFields: ["code", "name", "remark", "webBaseAddress", "apiBaseAddress", "rank"],
    writableFields: ["code", "name", "remark", "webBaseAddress", "apiBaseAddress", "rank"],
    tenant: { policy: "global" },
    capabilities: ["query", "write", "compare", "sync"],
    help: "应用模块按 code 查询、创建或更新；新增缺少 rank 时默认 1；仅允许 global 租户。",
    defaults: {
      create: { rank: 1 },
      preserveTargetFieldsWhenMissing: ["rank"]
    },
    filtering: { time: true, defaultTimeField: "createdDate" },
    rollback: { service: "sei-basic", resource: "appModule", deleteMethod: "DELETE" }
  };
