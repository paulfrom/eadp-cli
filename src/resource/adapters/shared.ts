import { CliError } from "../../errors.js";
import type { ResourceRecord } from "../core/client.js";
import { DependencyResolutionError, RecordMappingError } from "../core/errors.js";

export function normalizeFeatureUrl(value: string): string {
  const trimmed = value.trim();
  const withoutBoundarySlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutBoundarySlashes ? `/${withoutBoundarySlashes}` : "/";
}

export function normalizeConfigItems(value: unknown): ResourceRecord[] {
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

export function selectDependencyByCode(
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

export function recordId(record: ResourceRecord, label: string): string {
  return requiredString(record.id, `${label}缺少有效 ID`);
}

export function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new CliError(message);
  return value;
}
