import { CliError } from "../errors.js";
import type { ResourceClient, ResourceRecord } from "./client.js";

export interface ResourceSpec {
  name: string;
  service: string;
  endpoint: string;
  identityField: string;
  writableFields: string[];
  toDesired(
    source: ResourceRecord,
    targetClient: ResourceClient
  ): Promise<ResourceRecord>;
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
  "mobileUse",
  "specialProjectId"
];

const featureSpec: ResourceSpec = {
  name: "feature",
  service: "sei-basic",
  endpoint: "feature",
  identityField: "code",
  writableFields: featureWritableFields,
  async toDesired(source, targetClient) {
    const appModuleCode = requiredString(source.appModuleCode, "功能项缺少 appModuleCode");
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectByCode(appModules, appModuleCode, "目标环境应用模块");

    let featureGroupId: string | undefined;
    if (typeof source.featureGroupCode === "string" && source.featureGroupCode) {
      const featureGroups = await targetClient.findAll("featureGroup");
      featureGroupId = recordId(
        selectByCode(
          featureGroups,
          source.featureGroupCode,
          "目标环境功能项组"
        ),
        "目标环境功能项组"
      );
    } else if (typeof source.featureGroupId === "string" && source.featureGroupId) {
      throw new CliError(
        `功能项 ${String(source.code)} 包含功能项组 ID，但源接口未返回 featureGroupCode`
      );
    }

    if (typeof source.specialProjectId === "string" && source.specialProjectId) {
      throw new CliError(
        `功能项 ${String(source.code)} 关联专用项目，当前无法安全映射 specialProjectId`
      );
    }

    const desired: ResourceRecord = {};
    for (const field of featureWritableFields) {
      if (field in source) {
        desired[field] = source[field];
      }
    }
    desired.appModuleId = recordId(appModule, "目标环境应用模块");
    if (featureGroupId === undefined) {
      delete desired.featureGroupId;
    } else {
      desired.featureGroupId = featureGroupId;
    }
    delete desired.specialProjectId;
    return desired;
  }
};

const specs = new Map<string, ResourceSpec>([[featureSpec.name, featureSpec]]);

export function getResourceSpec(name: string): ResourceSpec {
  const spec = specs.get(name);
  if (!spec) {
    throw new CliError(
      `资源 ${name} 尚未注册同步规则；当前支持：${[...specs.keys()].join(", ")}`
    );
  }
  return spec;
}

export function listResourceSpecs(): string[] {
  return [...specs.keys()];
}

function selectByCode(
  records: ResourceRecord[],
  code: string,
  label: string
): ResourceRecord {
  const normalized = code.trim().toLocaleLowerCase();
  const matches = records.filter(
    (record) =>
      typeof record.code === "string" &&
      record.code.trim().toLocaleLowerCase() === normalized
  );
  if (matches.length === 0) {
    throw new CliError(`${label}不存在：${code}`);
  }
  if (matches.length > 1) {
    throw new CliError(`${label}代码不唯一：${code}`);
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
