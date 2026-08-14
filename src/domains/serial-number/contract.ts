import type { ResourceContract } from "../../resource/core/contracts.js";

export const serialNumberContract: ResourceContract =   {
    id: "serial-number",
    title: "给号配置",
    description: "查询、创建或更新给号配置；业务唯一键为 entityClassName + tenantCode。",
    service: "sei-basic",
    query: { path: "serialNumberConfig/findByPage", method: "POST" },
    save: { path: "serialNumberConfig/save", method: "POST" },
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
    identityFields: ["entityClassName", "tenantCode"],
    compareFields: [
      "appModuleCode", "appModuleName", "entityClassName", "configType", "name",
      "expressionConfig", "minNumber", "maxNumber", "useDeleted", "cycleStrategy",
      "returnStrategy", "activated", "genFlag", "tenantCode", "publicFlag",
      "tenantIsolation", "isolationExpression", "configItem"
    ],
    writableFields: [
      "appModuleCode", "appModuleName", "entityClassName", "configType", "name",
      "expressionConfig", "minNumber", "maxNumber", "useDeleted", "cycleStrategy",
      "returnStrategy", "activated", "genFlag", "tenantCode", "publicFlag",
      "tenantIsolation", "isolationExpression", "configItem"
    ],
    tenant: { policy: "global", bindField: "tenantCode" },
    capabilities: ["query", "write", "compare", "sync"],
    help: "给号配置自动绑定目标环境 tenantCode；新增时缺失/null/空白 configType 默认 CODE_TYPE、returnStrategy 默认 NEW。",
    defaults: {
      create: { returnStrategy: "NEW", configType: "CODE_TYPE" },
      preserveTargetFieldsWhenMissing: ["returnStrategy"]
    },
    filtering: { time: true, defaultTimeField: "createdDate" },
    enums: {
      configType: [
        { value: "CODE_TYPE", meaning: "主数据编号" },
        { value: "BAR_TYPE", meaning: "条码" }
      ],
      cycleStrategy: [
        { value: "MAX_CYCLE", meaning: "达到最大号后循环" },
        { value: "DAY_CYCLE", meaning: "按日循环" },
        { value: "MONTH_CYCLE", meaning: "按月循环" },
        { value: "YEAR_CYCLE", meaning: "按年循环" }
      ],
      returnStrategy: [
        { value: "NEW", meaning: "每次新给号" },
        { value: "REPEAT", meaning: "同一关联对象优先复用已有条码" },
        { value: "PATCH", meaning: "补号策略" }
      ],
      "configItem[].linkCharacter": [
        { value: "EMPTY", meaning: "空字符串" },
        { value: "DASH", meaning: "短横线" },
        { value: "DOT", meaning: "点" },
        { value: "PIPE", meaning: "竖线" },
        { value: "COLON", meaning: "冒号" }
      ],
      "configItem[].elementCode": [
        { value: "FIXED_CODE", meaning: "固定编码" },
        { value: "DATE_CODE", meaning: "日期编码" },
        { value: "SERIAL_CODE", meaning: "流水号编码；也允许目标服务已登记的自定义元素代码" }
      ]
    },
    adapter: "serial-number",
    rollback: { service: "sei-basic", resource: "serialNumberConfig", remove: { path: "serialNumberConfig/delete/{id}", method: "POST", idField: "id", idPlacement: "path" }, lookup: { path: "serialNumberConfig/getDetail", method: "GET", idField: "id", idPlacement: "query" } }
  };
