import type { ResourceRecord } from "../core/client.js";
import type { ResourceAdapter } from "../core/engine.js";
import { recordId, requiredString, selectDependencyByCode } from "./shared.js";

const writableFields = ["code", "name", "appModuleId"];

export const featureGroupAdapter: ResourceAdapter = {
  async toDesired(source, targetClient) {
    const appModuleCode = requiredString(source.appModuleCode, "功能项组缺少 appModuleCode");
    const appModules = await targetClient.findAll("appModule");
    const appModule = selectDependencyByCode(appModules, appModuleCode, "app-module");
    const desired: ResourceRecord = {};
    for (const field of writableFields) {
      if (field in source) desired[field] = source[field];
    }
    desired.code = requiredString(source.code, "功能项组缺少 code");
    desired.name = requiredString(source.name, "功能项组缺少 name");
    desired.appModuleId = recordId(appModule, "目标环境应用模块");
    return desired;
  }
};
