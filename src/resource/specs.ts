import { CliError } from "../errors.js";
import type { ResourceClient, ResourceRecord } from "./client.js";

export interface ResourceSpec {
  name: string;
  service: string;
  endpoint: string;
  /** Fields that together form the resource's business identity. */
  identityFields: string[];
  writableFields: string[];
  preserveTargetFields?: string[];
  toDesired(
    source: ResourceRecord,
    targetClient: ResourceClient,
    context: { targetTenantCode: string }
  ): Promise<ResourceRecord>;
  compareValue?(record: ResourceRecord, field: string): unknown;
}

export interface MissingDependency {
  resource: string;
  identityField: "code";
  value: string;
  reason: "missing" | "ambiguous";
}

export interface BlockingIssue {
  resource: string;
  field: string;
  reason: "invalid";
  message: string;
}

export class DependencyResolutionError extends CliError {
  constructor(readonly missingDependencies: MissingDependency[]) {
    super(
      missingDependencies
        .map((dependency) =>
          `${dependency.resource}.${dependency.identityField}=${dependency.value} (${dependency.reason})`
        )
        .join(", ")
    );
  }
}

export class RecordMappingError extends CliError {
  constructor(readonly blockingIssues: BlockingIssue[]) {
    super(blockingIssues.map((issue) => issue.message).join(", "));
  }
}

const featureWritableFields = [
  "code",
  "name",
  "groupCode",
  "url",
  "canMenu",
  "featureType",
  "appModuleId",
  "featureGroupId",
  "tenantCanUse",
  "mobileUse"
];

const featureSpec: ResourceSpec = {
  name: "feature",
  service: "sei-basic",
  endpoint: "feature",
  identityFields: ["code"],
  writableFields: featureWritableFields,
  preserveTargetFields: ["specialProjectId"],
  async toDesired(source, targetClient) {
    const appModuleCode = requiredString(source.appModuleCode, "功能项缺少 appModuleCode");
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectDependencyByCode(
      appModules,
      appModuleCode,
      "app-module"
    );

    let featureGroupId: string | undefined;
    if (typeof source.featureGroupCode === "string" && source.featureGroupCode) {
      const featureGroups = await targetClient.findAll("featureGroup");
      featureGroupId = recordId(
        selectDependencyByCode(
          featureGroups,
          source.featureGroupCode,
          "feature-group"
        ),
        "目标环境功能项组"
      );
    } else if (typeof source.featureGroupId === "string" && source.featureGroupId) {
      throw new CliError(
        `功能项 ${String(source.code)} 包含功能项组 ID，但源接口未返回 featureGroupCode`
      );
    }

    const desired: ResourceRecord = {};
    for (const field of featureWritableFields) {
      if (field in source) {
        desired[field] = source[field];
      }
    }
    if (typeof desired.url === "string") {
      desired.url = normalizeFeatureUrl(desired.url);
    }
    desired.appModuleId = recordId(appModule, "目标环境应用模块");
    if (featureGroupId === undefined) {
      delete desired.featureGroupId;
    } else {
      desired.featureGroupId = featureGroupId;
    }
    return desired;
  },
  compareValue(record, field) {
    return field === "url" && typeof record.url === "string"
      ? normalizeFeatureUrl(record.url)
      : record[field];
  }
};

const featureGroupWritableFields = ["code", "name", "appModuleId"];

const featureGroupSpec: ResourceSpec = {
  name: "feature-group",
  service: "sei-basic",
  endpoint: "featureGroup",
  identityFields: ["code"],
  writableFields: featureGroupWritableFields,
  async toDesired(source, targetClient) {
    const appModuleCode = requiredString(
      source.appModuleCode,
      "功能项组缺少 appModuleCode"
    );
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectDependencyByCode(
      appModules,
      appModuleCode,
      "app-module"
    );
    return {
      code: requiredString(source.code, "功能项组缺少 code"),
      name: requiredString(source.name, "功能项组缺少 name"),
      appModuleId: recordId(appModule, "目标环境应用模块")
    };
  }
};

const serialNumberWritableFields = [
  "appModuleCode",
  "appModuleName",
  "entityClassName",
  "configType",
  "name",
  "expressionConfig",
  "minNumber",
  "maxNumber",
  "useDeleted",
  "cycleStrategy",
  "returnStrategy",
  "activated",
  "genFlag",
  "tenantCode",
  "publicFlag",
  "tenantIsolation",
  "isolationExpression",
  "configItem"
];

const serialNumberSpec: ResourceSpec = {
  name: "serial-number",
  service: "sei-basic",
  endpoint: "serialNumberConfig",
  identityFields: ["entityClassName", "tenantCode"],
  writableFields: serialNumberWritableFields,
  async toDesired(source, _targetClient, context) {
    const desired: ResourceRecord = {};
    for (const field of serialNumberWritableFields) {
      if (field in source) desired[field] = source[field];
    }
    desired.configType = typeof source.configType === "string" ? source.configType : "CODE_TYPE";
    desired.tenantCode = context.targetTenantCode;
    desired.configItem = normalizeConfigItems(source.configItem);
    return desired;
  },
  compareValue(record, field) {
    return field === "configItem" ? normalizeConfigItems(record.configItem) : record[field];
  }
};

const menuSpec: ResourceSpec = {
  name: "menu",
  service: "sei-basic",
  endpoint: "menu",
  identityFields: ["code"],
  writableFields: ["name", "rank", "iconCls", "parentCode", "featureCode"],
  async toDesired() {
    throw new CliError("menu 使用树形专用同步工作流");
  }
};

const specs = new Map<string, ResourceSpec>([
  [featureSpec.name, featureSpec],
  [featureGroupSpec.name, featureGroupSpec],
  [serialNumberSpec.name, serialNumberSpec],
  [menuSpec.name, menuSpec]
]);

export function getResourceSpec(name: string): ResourceSpec {
  const spec = specs.get(name);
  if (!spec) {
    throw new CliError(
      `资源 ${name} 尚未注册同步规则；当前支持：${listResourceSpecs().join(", ")}`
    );
  }
  return spec;
}

export function listResourceSpecs(): string[] {
  return [featureSpec.name, featureGroupSpec.name, menuSpec.name, serialNumberSpec.name];
}

function normalizeFeatureUrl(value: string): string {
  const trimmed = value.trim();
  const withoutBoundarySlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutBoundarySlashes ? `/${withoutBoundarySlashes}` : "/";
}

function normalizeConfigItems(value: unknown): ResourceRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidSerialNumberConfigItem("给号配置缺少 configItem");
  }
  const fields = [
    "elementName",
    "elementCode",
    "elementValue",
    "isolation",
    "linkCharacter",
    "sort"
  ];
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalidSerialNumberConfigItem(`给号配置 configItem[${index}] 格式无效`);
    }
    const source = item as ResourceRecord;
    const normalized: ResourceRecord = {};
    for (const field of fields) {
      if (field in source) normalized[field] = source[field];
    }
    return normalized;
  });
}

function invalidSerialNumberConfigItem(message: string): RecordMappingError {
  return new RecordMappingError([{
    resource: "serial-number",
    field: "configItem",
    reason: "invalid",
    message
  }]);
}

function selectDependencyByCode(
  records: ResourceRecord[],
  code: string,
  resource: string
): ResourceRecord {
  const normalized = code.trim().toLocaleLowerCase();
  const matches = records.filter(
    (record) =>
      typeof record.code === "string" &&
      record.code.trim().toLocaleLowerCase() === normalized
  );
  if (matches.length === 0) {
    throw new DependencyResolutionError([{
      resource,
      identityField: "code",
      value: code,
      reason: "missing"
    }]);
  }
  if (matches.length > 1) {
    throw new DependencyResolutionError([{
      resource,
      identityField: "code",
      value: code,
      reason: "ambiguous"
    }]);
  }
  return matches[0]!;
}

function recordId(record: ResourceRecord, label: string): string {
  return requiredString(record.id, `${label}缺少有效 ID`);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) {
    throw new CliError(message);
  }
  return value;
}
