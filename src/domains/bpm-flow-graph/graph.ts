import { CliError } from "../../errors.js";
import type { ResourceRecord } from "../../resource/core/client.js";
import {
  DependencyResolutionError,
  RecordMappingError,
  type BlockingIssue,
  type MissingDependency
} from "../../resource/core/errors.js";
import type { BpmGraphReferences } from "./references.js";
import { resolveNodeKind, type NodeIssue } from "./node-catalog.js";
import { inspectCanonicalGraph } from "./analysis.js";

type RecordValue = Record<string, unknown>;

const GRAPH_RESOURCE = "bpm-flow-graph";

const NOTIFY_TYPES = [
  "notifyExecutor",
  "notifyStarter",
  "notifyPosition",
  "notifySelfDefinition",
  "notifyPositionType"
] as const;

const PROCESS_SERVICE_FIELDS = [
  ["beforeStartServiceId", "beforeStartServiceUrl"],
  ["afterStartServiceId", "afterStartServiceUrl"],
  ["beforeEndServiceId", "beforeEndServiceUrl"],
  ["afterEndServiceId", "afterEndServiceUrl"]
] as const;

const EVENT_SERVICE_FIELDS = [
  ["beforeExcuteServiceId", "beforeExcuteServiceUrl"],
  ["afterExcuteServiceId", "afterExcuteServiceUrl"]
] as const;

/**
 * Service-side fields that either identify the current environment or are
 * recomputed on every save. They must never participate in cross-environment
 * comparison.
 */
const STRIPPED_ROOT_FIELDS = [
  "id",
  "name",
  "flowTypeId",
  "flowTypeName",
  "orgId",
  "orgName",
  "codePath",
  "namePath",
  "startCondition",
  "migrateFlowData",
  "appointExecutorAtStart",
  "defXml",
  "actDefId",
  "actDeployId",
  "versionCode",
  "flowDefinitionStatus",
  "publishNote",
  "tenantCode",
  "creatorName",
  "createdDate",
  "lastEditorName",
  "lastEditedDate"
] as const;

export interface HydrateOptions {
  flowTypeId: string;
  targetDefinition?: ResourceRecord;
}

/**
 * Convert one source design (`defFlowVersion/getFlowDesign`) into the stable
 * canonical graph string that is the only compared field of this resource.
 */
export async function toCanonical(
  defJson: string,
  refs: BpmGraphReferences
): Promise<string> {
  const issues: BlockingIssue[] = [];
  const raw = parseGraph(defJson, "流程图设计稿");
  const root = deepClone(raw);
  const sourceOrgId = text(root.orgId);
  for (const field of STRIPPED_ROOT_FIELDS) delete root[field];

  if (!text(root.orgCode) && sourceOrgId) {
    const organizations = await refs.organizations();
    const matches = organizations.filter((item) => text(item.id) === sourceOrgId);
    if (matches.length !== 1) {
      pushIssue(issues, "organization", "id", sourceOrgId,
        `源流程组织机构无法解析：${sourceOrgId}`);
    } else {
      const code = text(matches[0]!.code);
      if (!code) {
        pushIssue(issues, "organization", "code", sourceOrgId,
          "源流程组织机构缺少 code");
      } else {
        root.orgCode = code;
      }
    }
  } else if (!text(root.orgCode)) {
    delete root.orgCode;
  }

  const [pages, interfaces] = await Promise.all([refs.pages(), refs.interfaces()]);
  const pagesById = indexBy(pages, "id");
  const interfacesById = indexBy(interfaces, "id");

  const process = requireRecord(root.process, issues, "流程图缺少 process 对象");
  if (!process) throw new RecordMappingError(issues);
  const processName = text(process.name);
  if (!processName) {
    pushIssue(issues, GRAPH_RESOURCE, "process.name", null, "流程图缺少 process.name");
  }
  process.startUEL = normalizeUel(process.startUEL);
  delete process.id;
  delete process.flowDefVersionId;
  for (const [idField, urlField] of PROCESS_SERVICE_FIELDS) {
    mapServiceReference(process, idField, urlField, interfacesById, issues);
  }

  const nodes = requireRecord(process.nodes, issues, "流程图缺少 process.nodes 对象");
  if (!nodes) throw new RecordMappingError(issues);
  const nodeKeys = new Set(Object.keys(nodes));
  let startCount = 0;
  let endCount = 0;

  for (const [key, value] of Object.entries(nodes)) {
    if (!isRecord(value)) {
      pushIssue(issues, GRAPH_RESOURCE, "process.nodes", key, `节点 ${key} 不是对象`);
      continue;
    }
    const node = deepClone(value);
    nodes[key] = node;

    const id = text(node.id);
    if (!id) {
      pushIssue(issues, GRAPH_RESOURCE, "id", key, `节点 ${key} 缺少 id`);
    } else if (id !== key) {
      pushIssue(issues, GRAPH_RESOURCE, "id", id, `节点 ${key} 的 id 与键不一致`);
    }
    const resolution = resolveNodeKind(node);
    const rule = resolution.rule;
    for (const nodeIssue of resolution.issues) {
      pushIssue(issues, GRAPH_RESOURCE, nodeIssue.field ?? "type", key, nodeIssue.message);
    }
    if (rule?.migration.policy === "blocked") {
      pushIssue(issues, GRAPH_RESOURCE, "type", key,
        rule.migration.reason ?? `节点 ${key} 的 ${rule.kind} 不支持跨环境迁移`);
    }
    if (rule?.kind === "StartEvent") startCount += 1;
    if (rule?.kind === "EndEvent" || rule?.kind === "TerminateEndEvent") endCount += 1;
    if (!text(node.name)) {
      pushIssue(issues, GRAPH_RESOURCE, "name", key, `节点 ${key} 缺少 name`);
    }

    mapNodeTargets(node, key, nodeKeys, issues);
    delete node.flowNewPosition;
    delete node.flowOldPosition;

    const config = nodeConfigOf(node, key, issues);
    if (hasContent(config.smartAudit) ||
        hasContent(config.ruleConfig) ||
        (isRecord(config.smartAudit) && hasContent(config.smartAudit.ruleConfig))) {
      pushIssue(issues, GRAPH_RESOURCE, "smartAudit", key,
        `节点 ${key} 配置了智能审核/规则检查，v1 不支持跨环境迁移`);
    }

    if (isRecord(config.normal)) {
      mapServiceReference(config.normal, "serviceTaskId", "serviceTaskUrl", interfacesById, issues);
      mapPageReference(config.normal, pagesById, issues, key);
    } else if (config.normal !== undefined && config.normal !== null) {
      pushIssue(issues, GRAPH_RESOURCE, "nodeConfig.normal", key, `节点 ${key} 的 normal 配置无效`);
    }

    const event = isRecord(config.event) ? deepClone(config.event) : {};
    if (config.event !== undefined && config.event !== null && !isRecord(config.event)) {
      pushIssue(issues, GRAPH_RESOURCE, "nodeConfig.event", key, `节点 ${key} 的 event 配置无效`);
    }
    config.event = event;
    for (const [idField, urlField] of EVENT_SERVICE_FIELDS) {
      mapServiceReference(event, idField, urlField, interfacesById, issues);
    }

    if (config.executor !== undefined && config.executor !== null) {
      config.executor = await canonicalExecutors(config.executor, refs, interfacesById, issues, key);
    }

    if (isRecord(config.otherParams) && isRecord(config.otherParams.autoExecuteUser)) {
      mapServiceReference(
        config.otherParams.autoExecuteUser,
        "autoExecuteUserId",
        "autoExecuteServiceUrl",
        interfacesById,
        issues
      );
    }

    config.notify = await canonicalNotify(config.notify, pagesById, interfacesById, refs, issues, key);

    if (rule?.executor?.required) {
      const executors = config.executor;
      if (!Array.isArray(executors) || executors.length === 0) {
        pushIssue(issues, GRAPH_RESOURCE, "executor", key, `用户任务 ${key} 缺少执行人`);
      }
      if (!isRecord(config.normal) || !(text(config.normal.id) ?? text(config.normal.pageUrl))) {
        pushIssue(issues, GRAPH_RESOURCE, "nodeConfig.normal.id", key,
          `用户任务 ${key} 缺少 normal.id 页面`);
      }
    }
  }

  if (startCount !== 1) {
    pushIssue(issues, GRAPH_RESOURCE, "StartEvent", null,
      `流程图必须且只能有 1 个 StartEvent（实际 ${startCount} 个）`);
  }
  if (endCount < 1) {
    pushIssue(issues, GRAPH_RESOURCE, "EndEvent", null, "流程图至少需要 1 个 EndEvent");
  }
  if (issues.length > 0) throw new RecordMappingError(issues);

  root.process = process;
  return stableStringify(root);
}

/**
 * Turn the canonical graph back into a design payload for the target
 * environment. Source IDs are never copied: only codes/URLs are resolved.
 */
export async function hydrate(
  canonical: string,
  refs: BpmGraphReferences,
  options: HydrateOptions
): Promise<string> {
  const root = parseGraph(canonical, "规范化流程图");
  const missing: MissingDependency[] = [];
  const process = requireHydrateRecord(root.process, "规范化流程图缺少 process 对象");
  const nodes = requireHydrateRecord(process.nodes, "规范化流程图缺少 process.nodes 对象");

  const [pages, interfaces] = await Promise.all([refs.pages(), refs.interfaces()]);
  const pagesByUrl = indexBy(pages, "pcUrl");
  const interfacesByUrl = indexBy(interfaces, "url");

  root.flowTypeId = options.flowTypeId;
  if (options.targetDefinition) {
    const definitionId = text(options.targetDefinition.id);
    if (!definitionId) {
      throw new RecordMappingError([{
        resource: "defFlowDefinition",
        field: "id",
        reason: "invalid",
        message: "目标流程定义缺少 ID"
      }]);
    }
    const defKey = text(options.targetDefinition.defKey);
    if (!defKey) {
      throw new RecordMappingError([{
        resource: "defFlowDefinition",
        field: "defKey",
        reason: "invalid",
        message: "目标流程定义缺少 defKey，无法保留运行 key"
      }]);
    }
    root.id = definitionId;
    process.id = defKey;
  } else {
    delete root.id;
    delete process.id;
  }
  delete process.flowDefVersionId;
  process.startUEL = normalizeUel(process.startUEL);

  const orgCode = text(root.orgCode);
  if (orgCode) {
    const organizations = await refs.organizations();
    const matches = organizations.filter((item) => text(item.code) === orgCode);
    if (matches.length !== 1) {
      missing.push(dependency("organization", orgCode, matches.length));
    } else {
      const organization = matches[0]!;
      root.orgId = text(organization.id) ?? null;
      root.orgCode = text(organization.code) ?? null;
      root.orgName = text(organization.name) ?? null;
      root.codePath = text(organization.codePath) ?? null;
      root.namePath = text(organization.namePath) ?? null;
    }
  } else {
    root.orgId = null;
    root.orgCode = null;
    root.orgName = null;
    root.codePath = null;
    root.namePath = null;
  }

  for (const [idField, urlField] of PROCESS_SERVICE_FIELDS) {
    hydrateServiceReference(process, idField, urlField, interfacesByUrl, missing);
  }

  for (const [key, value] of Object.entries(nodes)) {
    if (!isRecord(value)) throw new CliError(`节点 ${key} 的配置无效`);
    const resolution = resolveNodeKind(value);
    if (!resolution.rule || resolution.rule.migration.policy === "blocked") {
      const issues = resolution.issues.length > 0
        ? resolution.issues.map((item) => nodeIssueToBlocking(item, key))
        : [{
          resource: GRAPH_RESOURCE,
          field: "type",
          reason: "invalid" as const,
          message: `节点 ${key} 的类型不受支持，无法写入目标环境`
        }];
      throw new RecordMappingError(issues);
    }
    const config = nodeConfigOf(value, key, []);
    if (isRecord(config.normal)) {
      hydrateServiceReference(config.normal, "serviceTaskId", "serviceTaskUrl", interfacesByUrl, missing);
      hydratePageReference(config.normal, pagesByUrl, missing);
    }
    const event = isRecord(config.event) ? config.event : {};
    config.event = event;
    for (const [idField, urlField] of EVENT_SERVICE_FIELDS) {
      hydrateServiceReference(event, idField, urlField, interfacesByUrl, missing);
    }
    if (Array.isArray(config.executor)) {
      config.executor = await hydrateExecutors(config.executor, refs, interfacesByUrl, missing);
    } else if (config.executor !== undefined && config.executor !== null) {
      throw new CliError(`节点 ${key} 的 executor 必须是数组`);
    }
    if (isRecord(config.otherParams) && isRecord(config.otherParams.autoExecuteUser)) {
      hydrateServiceReference(
        config.otherParams.autoExecuteUser,
        "autoExecuteUserId",
        "autoExecuteServiceUrl",
        interfacesByUrl,
        missing
      );
    }
    config.notify = await hydrateNotify(config.notify, pagesByUrl, interfacesByUrl, refs, missing);
    ensureTargetUel(value);
  }

  if (missing.length > 0) throw new DependencyResolutionError(missing);
  root.process = process;
  return stableStringify(root);
}

/**
 * Validate a canonical (`pageUrl`/`employeeCodes` form) graph without
 * resolving target IDs. Used by `bpm graph validate` and `bpm graph import`
 * before any write, so a hand-edited file fails locally instead of at save.
 */
export function validateCanonicalGraph(canonical: string): BlockingIssue[] {
  return inspectCanonicalGraph(canonical).blockingIssues;
}

/** Key-sorted JSON string used for graph comparison and as the record value. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function canonicalExecutors(
  value: unknown,
  refs: BpmGraphReferences,
  interfacesById: Map<string, ResourceRecord[]>,
  issues: BlockingIssue[],
  nodeKey: string
): Promise<ResourceRecord[]> {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value]
      : [];
  if (!Array.isArray(value) && !isRecord(value)) {
    pushIssue(issues, GRAPH_RESOURCE, "executor", nodeKey, `节点 ${nodeKey} 的 executor 配置无效`);
  }
  const result: ResourceRecord[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      pushIssue(issues, GRAPH_RESOURCE, "executor", nodeKey, `节点 ${nodeKey} 的 executor 项不是对象`);
      continue;
    }
    const userType = text(entry.userType);
    if (!userType) {
      pushIssue(issues, GRAPH_RESOURCE, "executor.userType", nodeKey, `节点 ${nodeKey} 的执行人缺少 userType`);
      continue;
    }
    const type = text(entry.type) ?? userType;
    if (type === "ProjectPosition" || userType === "ProjectPosition") {
      pushIssue(issues, GRAPH_RESOURCE, "executor.userType", nodeKey,
        `节点 ${nodeKey} 使用了项目岗位（ProjectPosition），v1 不支持跨环境迁移`);
      continue;
    }
    switch (userType) {
      case "Person": {
        const codes = await canonicalCodeList(
          entry,
          "ids",
          "employee",
          issues,
          nodeKey,
          (ids) => refs.employeesByIds(ids)
        );
        result.push({ type, userType, employeeCodes: codes });
        break;
      }
      case "Position": {
        const codes = await canonicalCodeList(
          entry,
          "ids",
          "position",
          issues,
          nodeKey,
          (ids) => refs.positionsByIds(ids)
        );
        result.push({ type, userType, positionCodes: codes });
        break;
      }
      case "PositionType": {
        const categories = await refs.positionCategories();
        const codes = await canonicalCodesFromAll(entry, categories, issues, nodeKey, "positionCategory");
        result.push({ type, userType, positionCategoryCodes: codes });
        break;
      }
      case "Org": {
        const organizations = await refs.organizations();
        const codes = await canonicalCodesFromAll(entry, organizations, issues, nodeKey, "organization");
        result.push({ type, userType, orgCodes: codes });
        break;
      }
      case "OrganizationDimension": {
        const dimensions = await refs.dimensions();
        const codes = await canonicalCodesFromAll(entry, dimensions, issues, nodeKey, "organizationDimension");
        result.push({ type, userType, dimensionCodes: codes });
        break;
      }
      case "SelfDefinition": {
        const selfDefId = text(entry.selfDefId) ?? text(entry.selfDefOfOrgAndSelId);
        if (!selfDefId) {
          pushIssue(issues, GRAPH_RESOURCE, "executor.selfDefId", nodeKey,
            `节点 ${nodeKey} 的自定义执行人缺少 selfDefId`);
          result.push({ type, userType });
          break;
        }
        const matches = interfacesById.get(selfDefId) ?? [];
        const url = matches.length === 1 ? text(matches[0]!.url) : undefined;
        if (!url) {
          pushIssue(issues, GRAPH_RESOURCE, "executor.selfDefId", selfDefId,
            `节点 ${nodeKey} 的自定义执行人接口无法解析：${selfDefId}`);
          result.push({ type, userType });
        } else {
          result.push({ type, userType, selfDefServiceUrl: url });
        }
        break;
      }
      case "AnyOne": {
        const copy = deepClone(entry);
        delete copy.ids;
        delete copy.selfDefId;
        delete copy.selfDefOfOrgAndSelId;
        const dimensionCodes = await canonicalDimensionCodes(copy.rowdata, refs, issues, nodeKey);
        delete copy.rowdata;
        if (dimensionCodes.length > 0) copy.dimensionCodes = dimensionCodes;
        copy.type = type;
        copy.userType = userType;
        result.push(copy);
        break;
      }
      case "StartUser": {
        const copy = deepClone(entry);
        delete copy.ids;
        delete copy.rowdata;
        delete copy.selfDefId;
        delete copy.selfDefOfOrgAndSelId;
        copy.type = type;
        copy.userType = userType;
        result.push(copy);
        break;
      }
      default:
        pushIssue(issues, GRAPH_RESOURCE, "executor.userType", userType,
          `节点 ${nodeKey} 的执行人类型不受支持：${userType}`);
        break;
    }
  }
  return result;
}

async function canonicalCodeList(
  entry: RecordValue,
  idsField: string,
  resource: string,
  issues: BlockingIssue[],
  nodeKey: string,
  load: (ids: string[]) => Promise<ResourceRecord[]>
): Promise<string[]> {
  const ids = splitIds(entry[idsField]);
  if (ids.length === 0) {
    pushIssue(issues, GRAPH_RESOURCE, `executor.${idsField}`, nodeKey,
      `节点 ${nodeKey} 的 ${resource} 执行人 ids 为空`);
    return [];
  }
  const rows = await load(ids);
  const codes: string[] = [];
  for (const id of ids) {
    const matches = rows.filter((row) => text(row.id) === id);
    if (matches.length !== 1) {
      pushIssue(issues, resource, "code", id,
        `节点 ${nodeKey} 的 ${resource} 无法按 id 唯一解析：${id}`);
      continue;
    }
    const code = text(matches[0]!.code);
    if (!code) {
      pushIssue(issues, resource, "code", id, `节点 ${nodeKey} 的 ${resource} 缺少 code：${id}`);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

async function canonicalCodesFromAll(
  entry: RecordValue,
  rows: ResourceRecord[],
  issues: BlockingIssue[],
  nodeKey: string,
  resource: string
): Promise<string[]> {
  const ids = splitIds(entry.ids);
  if (ids.length === 0) {
    pushIssue(issues, GRAPH_RESOURCE, "executor.ids", nodeKey,
      `节点 ${nodeKey} 的 ${resource} 执行人 ids 为空`);
    return [];
  }
  const codes: string[] = [];
  for (const id of ids) {
    const matches = rows.filter((row) => text(row.id) === id);
    if (matches.length !== 1) {
      pushIssue(issues, resource, "code", id,
        `节点 ${nodeKey} 的 ${resource} 无法按 id 唯一解析：${id}`);
      continue;
    }
    const code = text(matches[0]!.code);
    if (!code) {
      pushIssue(issues, resource, "code", id, `节点 ${nodeKey} 的 ${resource} 缺少 code：${id}`);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** AnyOne keeps its organization-dimension restriction in `rowdata`. */
async function canonicalDimensionCodes(
  value: unknown,
  refs: BpmGraphReferences,
  issues: BlockingIssue[],
  nodeKey: string
): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    pushIssue(issues, GRAPH_RESOURCE, "executor.rowdata", nodeKey,
      `节点 ${nodeKey} 的任意执行人维度配置无效`);
    return [];
  }
  if (value.length === 0) return [];
  const dimensions = await refs.dimensions();
  const codes: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      pushIssue(issues, GRAPH_RESOURCE, "executor.rowdata", nodeKey,
        `节点 ${nodeKey} 的任意执行人维度项不是对象`);
      continue;
    }
    const id = text(item.id);
    if (!id) {
      pushIssue(issues, GRAPH_RESOURCE, "executor.rowdata", nodeKey,
        `节点 ${nodeKey} 的任意执行人维度项缺少 id`);
      continue;
    }
    const matches = dimensions.filter((row) => text(row.id) === id);
    if (matches.length !== 1) {
      pushIssue(issues, "organizationDimension", "code", id,
        `节点 ${nodeKey} 的任意执行人维度无法按 id 唯一解析：${id}`);
      continue;
    }
    const code = text(matches[0]!.code);
    if (!code) {
      pushIssue(issues, "organizationDimension", "code", id,
        `节点 ${nodeKey} 的任意执行人维度缺少 code：${id}`);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

async function canonicalNotify(
  value: unknown,
  pagesById: Map<string, ResourceRecord[]>,
  interfacesById: Map<string, ResourceRecord[]>,
  refs: BpmGraphReferences,
  issues: BlockingIssue[],
  nodeKey: string
): Promise<RecordValue | null> {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    pushIssue(issues, GRAPH_RESOURCE, "nodeConfig.notify", nodeKey, `节点 ${nodeKey} 的 notify 配置无效`);
    return null;
  }
  const notify = deepClone(value);
  for (const phaseName of ["before", "after"] as const) {
    const phaseValue = notify[phaseName];
    const phase = isRecord(phaseValue) ? deepClone(phaseValue) : {};
    if (phaseValue !== undefined && phaseValue !== null && !isRecord(phaseValue)) {
      pushIssue(issues, GRAPH_RESOURCE, `nodeConfig.notify.${phaseName}`, nodeKey,
        `节点 ${nodeKey} 的 notify.${phaseName} 配置无效`);
    }
    for (const typeName of NOTIFY_TYPES) {
      const itemValue = phase[typeName];
      if (itemValue === undefined || itemValue === null) {
        delete phase[typeName];
        continue;
      }
      if (!isRecord(itemValue)) {
        pushIssue(issues, GRAPH_RESOURCE, `nodeConfig.notify.${typeName}`, nodeKey,
          `节点 ${nodeKey} 的 notify.${typeName} 配置无效`);
        delete phase[typeName];
        continue;
      }
      const item = deepClone(itemValue);
      mapPageIdReference(item, pagesById, issues);
      mapServiceReference(item, "notifySelfDefId", "selfDefServiceUrl", interfacesById, issues);
      item.positionCodes = await canonicalPositionCodes(
        item.positionData,
        refs,
        "position",
        issues,
        nodeKey
      );
      if ((item.positionCodes as string[]).length === 0) delete item.positionCodes;
      delete item.positionData;
      item.positionCategoryCodes = await canonicalPositionCodes(
        item.positionTypeData,
        refs,
        "positionCategory",
        issues,
        nodeKey
      );
      if ((item.positionCategoryCodes as string[]).length === 0) delete item.positionCategoryCodes;
      delete item.positionTypeData;
      if (isEmptyRecord(item)) delete phase[typeName];
      else phase[typeName] = item;
    }
    notify[phaseName] = phase;
  }
  if (isEmptyRecord(notify.before) && isEmptyRecord(notify.after)) return null;
  return notify;
}

async function canonicalPositionCodes(
  value: unknown,
  refs: BpmGraphReferences,
  resource: "position" | "positionCategory",
  issues: BlockingIssue[],
  nodeKey: string
): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    pushIssue(issues, GRAPH_RESOURCE, `notify.${resource}`, nodeKey,
      `节点 ${nodeKey} 的 ${resource} 通知数据无效`);
    return [];
  }
  const rows = resource === "position"
    ? await refs.positionsByIds(value.flatMap((item) => {
      const id = isRecord(item) ? text(item.id) : undefined;
      return id ? [id] : [];
    }))
    : await refs.positionCategories();
  const codes: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      pushIssue(issues, GRAPH_RESOURCE, `notify.${resource}`, nodeKey,
        `节点 ${nodeKey} 的 ${resource} 通知项不是对象`);
      continue;
    }
    const id = text(item.id);
    if (!id) {
      pushIssue(issues, GRAPH_RESOURCE, `notify.${resource}`, nodeKey,
        `节点 ${nodeKey} 的 ${resource} 通知项缺少 id`);
      continue;
    }
    const matches = rows.filter((row) => text(row.id) === id);
    if (matches.length !== 1) {
      pushIssue(issues, resource, "code", id,
        `节点 ${nodeKey} 的 ${resource} 通知无法按 id 唯一解析：${id}`);
      continue;
    }
    const code = text(matches[0]!.code);
    if (!code) {
      pushIssue(issues, resource, "code", id, `节点 ${nodeKey} 的 ${resource} 通知缺少 code：${id}`);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function mapNodeTargets(
  node: RecordValue,
  nodeKey: string,
  nodeKeys: Set<string>,
  issues: BlockingIssue[]
): void {
  const targets = node.target;
  if (!Array.isArray(targets)) {
    pushIssue(issues, GRAPH_RESOURCE, "target", nodeKey, `节点 ${nodeKey} 缺少 target 数组`);
    return;
  }
  for (const target of targets) {
    if (!isRecord(target)) {
      pushIssue(issues, GRAPH_RESOURCE, "target", nodeKey, `节点 ${nodeKey} 的连线不是对象`);
      continue;
    }
    const targetId = text(target.targetId);
    if (!targetId) {
      pushIssue(issues, GRAPH_RESOURCE, "target.targetId", nodeKey, `节点 ${nodeKey} 的连线缺少 targetId`);
    } else if (!nodeKeys.has(targetId)) {
      pushIssue(issues, GRAPH_RESOURCE, "target.targetId", targetId,
        `节点 ${nodeKey} 的连线目标不存在：${targetId}`);
    }
    target.uel = normalizeUel(target.uel);
  }
}

function mapPageReference(
  container: RecordValue,
  pagesById: Map<string, ResourceRecord[]>,
  issues: BlockingIssue[],
  nodeKey: string
): void {
  const pageId = text(container.id);
  if (!pageId) {
    delete container.id;
    return;
  }
  const matches = pagesById.get(pageId) ?? [];
  if (matches.length !== 1) {
    pushIssue(issues, "conPage", "pcUrl", pageId,
      `节点 ${nodeKey} 的页面无法按 id 唯一解析：${pageId}`);
    return;
  }
  const pageUrl = text(matches[0]!.pcUrl);
  if (!pageUrl) {
    pushIssue(issues, "conPage", "pcUrl", pageId, `节点 ${nodeKey} 的页面缺少 pcUrl：${pageId}`);
    return;
  }
  container.pageUrl = pageUrl;
  delete container.id;
}

function mapPageIdReference(
  container: RecordValue,
  pagesById: Map<string, ResourceRecord[]>,
  issues: BlockingIssue[]
): void {
  const pageId = text(container.pageId);
  if (!pageId) {
    delete container.pageId;
    return;
  }
  const matches = pagesById.get(pageId) ?? [];
  if (matches.length !== 1) {
    pushIssue(issues, "conPage", "pcUrl", pageId, `通知页面无法按 id 唯一解析：${pageId}`);
  } else {
    const pageUrl = text(matches[0]!.pcUrl);
    if (!pageUrl) {
      pushIssue(issues, "conPage", "pcUrl", pageId, `通知页面缺少 pcUrl：${pageId}`);
    } else {
      container.pageUrl = pageUrl;
    }
  }
  delete container.pageId;
}

function mapServiceReference(
  container: RecordValue,
  idField: string,
  urlField: string,
  recordsById: Map<string, ResourceRecord[]>,
  issues: BlockingIssue[]
): void {
  const id = text(container[idField]);
  if (!id) {
    delete container[idField];
    return;
  }
  const matches = recordsById.get(id) ?? [];
  if (matches.length !== 1) {
    pushIssue(issues, "conInterface", "url", id, `接口引用无法按 id 唯一解析：${id}`);
    return;
  }
  const url = text(matches[0]!.url);
  if (!url) {
    pushIssue(issues, "conInterface", "url", id, `接口引用缺少 url：${id}`);
    return;
  }
  container[urlField] = url;
  delete container[idField];
}

async function hydrateExecutors(
  entries: unknown[],
  refs: BpmGraphReferences,
  interfacesByUrl: Map<string, ResourceRecord[]>,
  missing: MissingDependency[]
): Promise<ResourceRecord[]> {
  const result: ResourceRecord[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) throw new CliError("规范化流程图的执行人项无效");
    const userType = text(entry.userType);
    if (!userType) throw new CliError("规范化流程图的执行人缺少 userType");
    const type = text(entry.type) ?? userType;
    switch (userType) {
      case "Person":
        result.push(await hydrateCodeExecutor(entry, "employeeCodes", "employee", refs, missing));
        break;
      case "Position":
        result.push(await hydrateCodeExecutor(entry, "positionCodes", "position", refs, missing));
        break;
      case "PositionType":
        result.push(await hydrateCodeExecutor(entry, "positionCategoryCodes", "positionCategory", refs, missing));
        break;
      case "Org":
        result.push(await hydrateCodeExecutor(entry, "orgCodes", "organization", refs, missing));
        break;
      case "OrganizationDimension":
        result.push(await hydrateCodeExecutor(entry, "dimensionCodes", "organizationDimension", refs, missing));
        break;
      case "SelfDefinition": {
        const url = text(entry.selfDefServiceUrl);
        const output: RecordValue = { type, userType };
        if (url) {
          const target = hydrateUrlReference(output, "selfDefId", url, interfacesByUrl, "conInterface", missing);
          const name = target ? text(target.name) : undefined;
          if (name) output.name = name;
        }
        result.push(output);
        break;
      }
      case "AnyOne": {
        const output = deepClone(entry);
        output.type = type;
        output.userType = userType;
        const dimensionCodes = textArray(entry.dimensionCodes);
        delete output.dimensionCodes;
        if (dimensionCodes.length > 0) {
          const dimensions = await refs.dimensions();
          const selected: ResourceRecord[] = [];
          for (const code of dimensionCodes) {
            const matches = dimensions.filter((row) => text(row.code) === code);
            if (matches.length !== 1) {
              missing.push(dependency("organizationDimension", code, matches.length));
              continue;
            }
            selected.push(matches[0]!);
          }
          if (selected.length === dimensionCodes.length) {
            output.rowdata = selected.map((row) => ({
              id: text(row.id) ?? null,
              code: text(row.code) ?? null,
              name: text(row.name) ?? text(row.code) ?? null
            }));
          }
        }
        result.push(output);
        break;
      }
      case "StartUser": {
        const copy = deepClone(entry);
        copy.type = type;
        copy.userType = userType;
        delete copy.ids;
        delete copy.rowdata;
        delete copy.selfDefId;
        delete copy.selfDefOfOrgAndSelId;
        result.push(copy);
        break;
      }
      default:
        throw new CliError(`不支持的执行人类型：${userType}`);
    }
  }
  return result;
}

async function hydrateCodeExecutor(
  entry: RecordValue,
  codeField: string,
  resource: string,
  refs: BpmGraphReferences,
  missing: MissingDependency[]
): Promise<ResourceRecord> {
  const userType = text(entry.userType);
  if (!userType) throw new CliError("规范化流程图的执行人缺少 userType");
  const type = text(entry.type) ?? userType;
  const codes = textArray(entry[codeField]);
  if (codes.length === 0) throw new CliError(`执行人 ${codeField} 不能为空`);
  const rows = resource === "employee"
    ? await refs.employeesByCodes(codes)
    : resource === "position"
      ? await refs.positionsByCodes(codes)
      : resource === "positionCategory"
        ? await refs.positionCategories()
        : resource === "organization"
          ? await refs.organizations()
          : await refs.dimensions();
  const selected: ResourceRecord[] = [];
  for (const code of codes) {
    const matches = rows.filter((row) => text(row.code) === code);
    if (matches.length !== 1) {
      missing.push(dependency(resource, code, matches.length));
      continue;
    }
    selected.push(matches[0]!);
  }
  const output: RecordValue = { type, userType };
  if (selected.length === codes.length) {
    output.ids = selected.map((row) => text(row.id) ?? "").join(",");
    output.name = selected.map((row) => displayName(row, resource)).join(",");
    output.rowdata = selected.map((row) => ({
      id: text(row.id) ?? null,
      code: text(row.code) ?? null,
      name: displayName(row, resource)
    }));
  }
  return output;
}

function hydratePageReference(
  normal: RecordValue,
  pagesByUrl: Map<string, ResourceRecord[]>,
  missing: MissingDependency[]
): void {
  const url = text(normal.pageUrl);
  delete normal.id;
  if (url) {
    const matches = pagesByUrl.get(url) ?? [];
    if (matches.length !== 1) {
      missing.push(dependency("conPage", url, matches.length));
    } else {
      normal.id = text(matches[0]!.id) ?? null;
    }
  }
  delete normal.pageUrl;
}

/** Notification pages use `pageId`, not the user task's `normal.id`. */
function hydrateNotifyPageReference(
  container: RecordValue,
  pagesByUrl: Map<string, ResourceRecord[]>,
  missing: MissingDependency[]
): void {
  const url = text(container.pageUrl);
  delete container.pageId;
  if (url) {
    const matches = pagesByUrl.get(url) ?? [];
    if (matches.length !== 1) {
      missing.push(dependency("conPage", url, matches.length));
    } else {
      container.pageId = text(matches[0]!.id) ?? null;
    }
  }
  delete container.pageUrl;
}

function hydrateServiceReference(
  container: RecordValue,
  idField: string,
  urlField: string,
  recordsByUrl: Map<string, ResourceRecord[]>,
  missing: MissingDependency[]
): void {
  const url = text(container[urlField]);
  if (url) {
    hydrateUrlReference(container, idField, url, recordsByUrl, "conInterface", missing);
  } else {
    delete container[idField];
  }
  delete container[urlField];
}

function hydrateUrlReference(
  container: RecordValue,
  idField: string,
  url: string,
  recordsByUrl: Map<string, ResourceRecord[]>,
  resource: string,
  missing: MissingDependency[]
): ResourceRecord | undefined {
  delete container[idField];
  const matches = recordsByUrl.get(url) ?? [];
  if (matches.length !== 1) {
    missing.push(dependency(resource, url, matches.length));
    return undefined;
  }
  container[idField] = text(matches[0]!.id) ?? null;
  return matches[0];
}

async function hydrateNotify(
  value: unknown,
  pagesByUrl: Map<string, ResourceRecord[]>,
  interfacesByUrl: Map<string, ResourceRecord[]>,
  refs: BpmGraphReferences,
  missing: MissingDependency[]
): Promise<RecordValue> {
  const notify = isRecord(value) ? deepClone(value) : {};
  for (const phaseName of ["before", "after"] as const) {
    const phase = isRecord(notify[phaseName]) ? deepClone(notify[phaseName] as RecordValue) : {};
    for (const typeName of NOTIFY_TYPES) {
      const itemValue = phase[typeName];
      if (!isRecord(itemValue)) continue;
      const item = deepClone(itemValue);
      hydrateNotifyPageReference(item, pagesByUrl, missing);
      hydrateServiceReference(item, "notifySelfDefId", "selfDefServiceUrl", interfacesByUrl, missing);
      await hydratePositionData(item, "positionData", "positionCodes", "position", refs, missing);
      await hydratePositionData(
        item,
        "positionTypeData",
        "positionCategoryCodes",
        "positionCategory",
        refs,
        missing
      );
      phase[typeName] = item;
    }
    notify[phaseName] = phase;
  }
  return notify;
}

async function hydratePositionData(
  container: RecordValue,
  dataField: string,
  codeField: string,
  resource: "position" | "positionCategory",
  refs: BpmGraphReferences,
  missing: MissingDependency[]
): Promise<void> {
  const codes = textArray(container[codeField]);
  delete container[codeField];
  delete container[dataField];
  if (codes.length === 0) return;
  const rows = resource === "position"
    ? await refs.positionsByCodes(codes)
    : await refs.positionCategories();
  const selected: ResourceRecord[] = [];
  for (const code of codes) {
    const matches = rows.filter((row) => text(row.code) === code);
    if (matches.length !== 1) {
      missing.push(dependency(resource, code, matches.length));
      continue;
    }
    selected.push(matches[0]!);
  }
  if (selected.length === codes.length) {
    container[dataField] = selected.map((row) => ({
      id: text(row.id) ?? null,
      code: text(row.code) ?? null,
      name: text(row.name) ?? text(row.code) ?? null
    }));
  }
}

function ensureTargetUel(node: RecordValue): void {
  const targets = node.target;
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    if (isRecord(target) && !("uel" in target)) target.uel = {};
  }
}

function nodeConfigOf(node: RecordValue, nodeKey: string, issues: BlockingIssue[]): RecordValue {
  if (isRecord(node.nodeConfig)) return node.nodeConfig;
  if (node.nodeConfig !== undefined && node.nodeConfig !== null) {
    pushIssue(issues, GRAPH_RESOURCE, "nodeConfig", nodeKey, `节点 ${nodeKey} 的 nodeConfig 配置无效`);
  }
  const config: RecordValue = {};
  node.nodeConfig = config;
  return config;
}

function normalizeUel(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  if (isRecord(value)) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function splitIds(value: unknown): string[] {
  const result: string[] = [];
  const append = (item: unknown): void => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed !== "" && !result.includes(trimmed)) result.push(trimmed);
    } else if (typeof item === "number") {
      const textValue = String(item);
      if (!result.includes(textValue)) result.push(textValue);
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) append(item);
  } else if (typeof value === "string") {
    for (const item of value.split(",")) append(item);
  } else {
    append(value);
  }
  return result;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "" && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

function displayName(row: ResourceRecord, resource: string): string {
  return text(row.userName) ?? text(row.name) ?? text(row.code) ?? resource;
}

function dependency(resource: string, value: string, matches: number): MissingDependency {
  return {
    resource,
    identityField: "code",
    value,
    reason: matches > 1 ? "ambiguous" : "missing"
  };
}

function indexBy(rows: ResourceRecord[], field: string): Map<string, ResourceRecord[]> {
  const index = new Map<string, ResourceRecord[]>();
  for (const row of rows) {
    const key = text(row[field]);
    if (!key) continue;
    const list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  }
  return index;
}

function parseGraph(value: string, label: string): RecordValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RecordMappingError([{
      resource: GRAPH_RESOURCE,
      field: "graph",
      reason: "invalid",
      message: `${label}不是合法 JSON`
    }]);
  }
  if (!isRecord(parsed)) {
    throw new RecordMappingError([{
      resource: GRAPH_RESOURCE,
      field: "graph",
      reason: "invalid",
      message: `${label}必须是 JSON 对象`
    }]);
  }
  return parsed;
}

function requireRecord(
  value: unknown,
  issues: BlockingIssue[],
  message: string
): RecordValue | undefined {
  if (isRecord(value)) return value;
  pushIssue(issues, GRAPH_RESOURCE, "graph", null, message);
  return undefined;
}

function requireHydrateRecord(value: unknown, message: string): RecordValue {
  if (isRecord(value)) return value;
  throw new CliError(message);
}

function nodeIssueToBlocking(issue: NodeIssue, nodeKey: string): BlockingIssue {
  return {
    resource: GRAPH_RESOURCE,
    field: issue.field ?? "type",
    reason: "invalid",
    message: `节点 ${nodeKey}：${issue.message}`,
    code: issue.code,
    severity: issue.severity,
    scope: "node",
    nodeId: nodeKey
  };
}

function pushIssue(
  issues: BlockingIssue[],
  resource: string,
  field: string,
  value: string | null,
  message: string
): void {
  const key = `${resource}:${field}:${value ?? ""}:${message}`;
  if (issues.some((issue) =>
    `${issue.resource}:${issue.field}:${issue.value ?? ""}:${issue.message}` === key)) {
    return;
  }
  issues.push({ resource, field, reason: "invalid", message, value });
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function isEmptyRecord(value: unknown): boolean {
  return !isRecord(value) || Object.keys(value).length === 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
