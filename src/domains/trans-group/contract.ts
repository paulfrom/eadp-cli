import type { ResourceContract } from "../../resource/core/contracts.js";

export const transGroupContract: ResourceContract = {
  id: "trans-group",
  title: "EAI 通道分组",
  description: "查询、创建、更新或迁移通道分组；业务唯一键为 code。",
  service: "sei-eai",
  query: { path: "transGroup/findByPage", method: "POST" },
  detail: {
    path: "transGroup/findOne",
    method: "GET",
    selectors: [{
      name: "id",
      field: "id",
      placement: "query",
      valuePlaceholder: "id",
      description: "通道分组 ID"
    }]
  },
  save: { path: "transGroup/save", method: "POST" },
  read: "paged",
  pagination: {
    pageField: "pageInfo",
    pageNumberField: "page",
    pageSizeField: "rows",
    startPage: 1,
    rowsField: "rows",
    pageSize: 500,
    totalSemantics: "pages"
  },
  identityFields: ["code"],
  compareFields: ["code", "name"],
  writableFields: ["code", "name"],
  tenant: { policy: "non-global" },
  capabilities: ["query", "detail", "write", "compare", "sync"],
  help: "通道分组按 code 匹配；通道引用分组时重新解析目标 groupId，不复制源 ID。",
  filtering: { time: true, defaultTimeField: "createdDate" },
  rollback: {
    service: "sei-eai",
    resource: "transGroup",
    remove: { path: "transGroup/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
    lookup: { path: "transGroup/findOne", method: "GET", idField: "id", idPlacement: "query" }
  }
};
