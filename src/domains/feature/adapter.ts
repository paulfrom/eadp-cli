import type { ResourceRecord } from "../../resource/core/client.js";
import type { ResourceAdapter } from "../../resource/core/engine.js";
import { RecordMappingError } from "../../resource/core/errors.js";
import { featureGroupContract } from "../feature-group/contract.js";
import {
  mappedRecordId,
  normalizeFeatureUrl,
  requiredMappedString,
  selectDependencyByCode
} from "../shared.js";

const writableFields = [
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

export const featureAdapter: ResourceAdapter = {
  preserveTargetFields: ["specialProjectId"],
  async toDesired(source, targetClient) {
    const appModuleCode = requiredMappedString(
      source.appModuleCode,
      "feature",
      "appModuleCode",
      "功能项缺少 appModuleCode"
    );
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectDependencyByCode(appModules, appModuleCode, "app-module");

    let featureGroupId: string | null | undefined;
    if (typeof source.featureGroupCode === "string" && source.featureGroupCode) {
      const featureGroups = await targetClient.queryContract(featureGroupContract);
      featureGroupId = mappedRecordId(
        selectDependencyByCode(featureGroups, source.featureGroupCode, "feature-group"),
        "feature-group",
        "目标环境功能项组"
      );
    } else if (typeof source.featureGroupId === "string" && source.featureGroupId) {
      throw new RecordMappingError([{
        resource: "feature",
        field: "featureGroupCode",
        reason: "invalid",
        message: `功能项 ${String(source.code)} 包含功能项组 ID，但源接口未返回 featureGroupCode`
      }]);
    } else if ("featureGroupCode" in source || "featureGroupId" in source) {
      featureGroupId = null;
    }

    const desired: ResourceRecord = {};
    for (const field of writableFields) {
      if (field in source) desired[field] = source[field];
    }
    if (typeof desired.url === "string") desired.url = normalizeFeatureUrl(desired.url);
    desired.appModuleId = mappedRecordId(appModule, "app-module", "目标环境应用模块");
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
