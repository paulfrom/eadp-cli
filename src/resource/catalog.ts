import { createResourceRegistry, type ResourceContract, type ResourceRegistry } from "./contracts.js";
import { createResourceAdapterRegistry } from "./engine.js";
import { getResourceSpec } from "./specs.js";

/**
 * Built-in ordinary resources.  The adapter names are resolved by the engine
 * and keep dependency mapping (feature/group/serial-number) out of the
 * command registration code.  Menu remains a special tree handler.
 */
export const resourceContracts: readonly ResourceContract[] = [
  {
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
  },
  {
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
  },
  {
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
    rollback: { service: "sei-basic", resource: "feature", deleteMethod: "DELETE" }
  },
  {
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
    help: "给号配置自动绑定目标环境 tenantCode；新增时缺失/null/空白 returnStrategy 默认 NEW。",
    defaults: {
      create: { returnStrategy: "NEW" },
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
    rollback: { service: "sei-basic", resource: "serialNumberConfig", deleteMethod: "POST" }
  },
  {
    id: "menu",
    title: "菜单树",
    description: "菜单树由专用 TypeScript 工作流按 code、parentCode、featureCode 处理。",
    service: "sei-basic",
    query: { path: "menu/getMenuTree", method: "GET" },
    read: "tree",
    identityFields: ["code"],
    compareFields: ["code", "name", "rank", "iconCls", "parentCode", "featureCode"],
    writableFields: [],
    tenant: { policy: "global" },
    capabilities: ["query", "compare", "sync"],
    help: "菜单比较/迁移使用菜单树专用处理器，按 URL 作为边界，不接受或复制源 ID。",
    filtering: { time: false },
    handler: "menu",
    selectors: ["code"]
  },
  {
    id: "bpm",
    title: "BPM 聚合",
    description: "BPM 流程基础数据由专用聚合处理器按流程选择器比较或迁移。",
    service: "sei-bpm",
    query: { path: "__handler__/bpm", method: "POST" },
    read: "handler",
    identityFields: [],
    compareFields: [],
    writableFields: [],
    tenant: { policy: "non-global" },
    capabilities: ["compare", "sync"],
    help: "BPM 不使用普通资源 HTTP 引擎；使用 --flow 指定流程代码、名称或 Entity 代码。",
    filtering: { time: false },
    handler: "bpm",
    selectors: ["flow"]
  }
];

export const resourceRegistry: ResourceRegistry = createResourceRegistry(resourceContracts);

export const resourceAdapterRegistry = createResourceAdapterRegistry([
  ["feature", getResourceSpec("feature")],
  ["feature-group", getResourceSpec("feature-group")],
  ["serial-number", getResourceSpec("serial-number")]
]);

export function getResourceContract(name: string): ResourceContract {
  return resourceRegistry.get(name);
}

export function listResourceContracts(): ResourceContract[] {
  return resourceRegistry.list();
}
