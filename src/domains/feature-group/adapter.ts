import type { ResourceRecord } from "../../resource/core/client.js";
import type { ResourceAdapter } from "../../resource/core/engine.js";
import {
  mappedRecordId,
  requiredMappedString,
  selectDependencyByCode
} from "../shared.js";

const writableFields = ["code", "name", "appModuleId"];

export const featureGroupAdapter: ResourceAdapter = {
  async toDesired(source, targetClient) {
    const appModuleCode = requiredMappedString(
      source.appModuleCode,
      "feature-group",
      "appModuleCode",
      "功能项组缺少 appModuleCode"
    );
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectDependencyByCode(appModules, appModuleCode, "app-module");
    const desired: ResourceRecord = {};
    for (const field of writableFields) {
      if (field in source) desired[field] = source[field];
    }
    desired.code = requiredMappedString(source.code, "feature-group", "code", "功能项组缺少 code");
    desired.name = requiredMappedString(source.name, "feature-group", "name", "功能项组缺少 name");
    desired.appModuleId = mappedRecordId(appModule, "app-module", "目标环境应用模块");
    return desired;
  }
};
