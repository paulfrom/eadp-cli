import type { ResourceContract } from "../../resource/core/contracts.js";

export const transContract: ResourceContract = {
  id: "trans",
  title: "EAI 通道配置",
  description: "按 code 查询、保存、比较或迁移通道及其图配置；同步不改变发布状态。",
  service: "sei-eai",
  query: { path: "trans/findByPage", method: "POST" },
  detail: {
    path: "trans/getDetail",
    method: "POST",
    selectors: [{
      name: "id",
      field: "id",
      placement: "query",
      valuePlaceholder: "id",
      description: "通道 ID；可先按 code 查询列表解析"
    }]
  },
  save: { path: "trans/save", method: "POST" },
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
    "code", "name", "groupCode", "logLastDay", "customResult", "antiRetry",
    "sync", "subscriber", "requestSample", "responseSample", "transGraph"
  ],
  writableFields: [
    "code", "name", "groupCode", "logLastDay", "customResult", "antiRetry",
    "sync", "subscriber", "requestSample", "responseSample", "transGraph"
  ],
  tenant: { policy: "non-global" },
  capabilities: ["query", "detail", "write", "compare", "sync"],
  help: "同步必须使用 --select code=<code>；按业务代码映射分组和来源系统，不复制源 ID，不自动发布或删除通道。",
  defaults: {
    create: { logLastDay: 60, customResult: false, antiRetry: false, sync: true },
    preserveTargetFieldsWhenMissing: [
      "name", "groupCode", "logLastDay", "customResult", "antiRetry",
      "sync", "subscriber", "requestSample", "responseSample"
    ]
  },
  filtering: { time: false },
  enums: {
    status: [
      { value: "INIT", meaning: "已初始化，尚未发布" },
      { value: "PUBLISH", meaning: "已发布" },
      { value: "FROZEN", meaning: "已冻结" }
    ]
  },
  handler: "trans",
  selectors: [{
    name: "code",
    valuePlaceholder: "code",
    description: "通道代码；每次比较或迁移一个通道",
    required: true
  }],
  dependencies: ["trans-group"],
  rollback: {
    service: "sei-eai",
    resource: "trans",
    remove: { path: "trans/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
    lookup: { path: "trans/findOne", method: "GET", idField: "id", idPlacement: "query" }
  }
};
