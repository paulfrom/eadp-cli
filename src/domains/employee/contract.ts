import type { ResourceContract } from "../../resource/core/contracts.js";

export const employeeContract: ResourceContract = {
  id: "employee",
  aliases: ["user"],
  title: "企业员工",
  description: "查询、创建或更新企业员工；user 是 employee 的资源别名，业务唯一键为 code。",
  service: "sei-basic",
  query: { path: "employee/findByPage", method: "POST" },
  save: { path: "employee/save", method: "POST" },
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
  compareFields: [
    "code", "userName", "organizationId", "frozen", "email", "mobile", "gender", "idCard"
  ],
  writableFields: [
    "code", "userName", "organizationId", "frozen", "email", "mobile", "gender", "idCard"
  ],
  tenant: { policy: "non-global" },
  capabilities: ["query", "write", "compare", "sync"],
  help: "企业员工使用 sei-basic/employee；写入或跨环境同步必须提供 organizationCode，由目标环境 organization/findByCode 映射 organizationId，绝不复制源 organizationId。",
  defaults: { create: { frozen: false, gender: false } },
  filtering: { time: true, defaultTimeField: "createdDate" },
  adapter: "employee",
  rollback: {
    service: "sei-basic",
    resource: "employee",
    remove: { path: "employee/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
    lookup: { path: "employee/findOne", method: "GET", idField: "id", idPlacement: "query" }
  },
  deletion: {
    service: "sei-basic",
    resource: "employee",
    remove: { path: "employee/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
    lookup: { path: "employee/findOne", method: "GET", idField: "id", idPlacement: "query" },
    restore: { path: "employee/save", method: "POST" }
  }
};
