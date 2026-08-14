import type { ResourceRecord } from "../../resource/core/client.js";
import type { ResourceAdapter } from "../../resource/core/engine.js";
import { normalizeConfigItems } from "../shared.js";

const writableFields = [
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

export const serialNumberAdapter: ResourceAdapter = {
  async toDesired(source, _targetClient, context) {
    const desired: ResourceRecord = {};
    for (const field of writableFields) {
      if (field in source) desired[field] = source[field];
    }
    desired.tenantCode = context.targetTenantCode;
    desired.configItem = normalizeConfigItems(source.configItem);
    return desired;
  },
  compareValue(record, field) {
    return field === "configItem" ? normalizeConfigItems(record.configItem) : record[field];
  }
};
