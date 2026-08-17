import { CliError } from "../../errors.js";
import type { OperationRecorder } from "../../operations/recorder.js";
import { stringField } from "./client.js";
import type { ResourceClient } from "../../resource/core/client.js";
import type { BlockingIssue } from "../../resource/core/errors.js";
import type {
  ResourceAggregatePlan,
  ResourceAggregatePlanContext,
  ResourceApplyContext,
  ResourcePhaseHooks,
  ResourcePlanChange,
  ResourceVerifyContext
} from "../../resource/core/engine.js";
import { assertBpmNameLength, bpmNameLengthError } from "./naming.js";

type RecordValue = Record<string, unknown>;
type SyncAction = "create" | "update" | "unchanged" | "blocked";

interface BpmBlockingIssue {
  resource: string;
  identityField: string;
  value: string | null;
  reason: "invalid" | "ambiguous";
  message: string;
}

interface PlannedRecord {
  resource: string;
  key: string;
  action: SyncAction;
  changedFields: string[];
  desired: RecordValue | null;
  before: RecordValue | null;
  id: string | null;
  blockingIssues?: BpmBlockingIssue[];
}

const moduleFields = [
  "code", "name", "remark", "serviceName", "apiBaseAddress", "webBaseAddress",
  "internalModule", "frozen", "rank"
];
const entityFields = [
  "name", "code", "depict", "serviceName", "conditionPropertiesAll",
  "conditionPropertiesValue", "conditionStatusReset", "pcLookUrl", "phoneLookUrl",
  "rank", "frozen"
];
const pageFields = [
  "name", "pcUrl", "pcLookUrl", "phoneUrl", "outsideInterface", "depict", "frozen", "rank"
];
const interfaceFields = [
  "name", "url", "compensationUrl", "depict", "interfaceType", "frozen", "rank", "param"
];
const flowFields = [
  "name", "code", "depict", "pcLookUrl", "phoneLookUrl", "rank", "frozen",
  "realtimeNodeStatus"
];

/** BPM extends the aggregate planning phase and the apply/verify phases. */
export const bpmPhaseHooks: ResourcePhaseHooks = {
  aggregatePlan: planBpmAggregate,
  apply: applyBpmChanges,
  verify: verifyBpmChanges
};

async function planBpmAggregate(context: ResourceAggregatePlanContext): Promise<ResourceAggregatePlan> {
  const selector = context.selectors.flow;
  if (!selector || selector.trim() === "") {
    throw new CliError(
      "resource bpm compare/sync 必须提供 --select flow=<流程代码、名称或 Entity 代码>",
      1,
      { code: "REQUIRED_SELECTOR_MISSING", requiredInput: "selector" }
    );
  }
  const sourceClient = context.sourceClient;
  const targetClient = context.targetClient;

  const sourceFlowTypes = (await sourceClient.findByPage("conFlowType")).rows;
  const sourceEntities = (await sourceClient.findByPage("conBusinessEntity")).rows;
  const sourceFlow = selectFlow(sourceFlowTypes, sourceEntities, selector);
  const sourceEntity = uniqueById(
    sourceEntities,
    requiredString(sourceFlow.businessEntityId, "源 BPM 流程缺少 businessEntityId"),
    "源 BPM 业务实体"
  );
  const sourceModules = (await sourceClient.findByPage("conBusinessModule")).rows;
  const sourceModule = uniqueById(
    sourceModules,
    requiredString(sourceEntity.businessModuleId, "源 BPM 业务实体缺少 businessModuleId"),
    "源 BPM 业务模块"
  );
  const sourceEntityId = requiredString(sourceEntity.id, "源 BPM 业务实体缺少 ID");
  const sourcePages = await sourceClient.getChildren("conEntityPage", sourceEntityId);
  const sourceInterfaces = await sourceClient.getChildren("conEntityInterface", sourceEntityId);

  const targetModules = (await targetClient.findByPage("conBusinessModule")).rows;
  const targetEntities = (await targetClient.findByPage("conBusinessEntity")).rows;
  const targetPages = (await targetClient.findByPage("conPage")).rows;
  const targetInterfaces = (await targetClient.findByPage("conInterface")).rows;
  const targetFlows = (await targetClient.findByPage("conFlowType")).rows;
  const changes: PlannedRecord[] = [];

  const moduleCode = requiredString(sourceModule.code, "源 BPM 业务模块缺少代码");
  const entityCode = requiredString(sourceEntity.code, "源 BPM 业务实体缺少代码");
  const flowCode = requiredString(sourceFlow.code, "源 BPM 流程类型缺少代码");
  const flowName = requiredString(sourceFlow.name, "源 BPM 流程类型缺少名称");
  assertBpmNameLength("业务模块", requiredString(sourceModule.name, "源 BPM 业务模块缺少名称"));
  assertBpmNameLength("业务实体", requiredString(sourceEntity.name, "源 BPM 业务实体缺少名称"));
  assertBpmNameLength("流程", flowName);
  const module = planRecord({
    resource: "conBusinessModule",
    key: moduleCode,
    source: sourceModule,
    fields: moduleFields,
    existing: uniqueMatch(
      targetModules,
      (item) => sameText(item.code, moduleCode),
      `目标 BPM 业务模块代码 ${moduleCode}`
    )
  });
  changes.push(module);

  const entity = planRecord({
    resource: "conBusinessEntity",
    key: entityCode,
    source: sourceEntity,
    fields: entityFields,
    extra: {
      businessModuleId: module.id,
      auditTypeId: null,
      auditTypeName: null
    },
    compareFields: [
      ...entityFields,
      "businessModuleId",
      "auditTypeId",
      "auditTypeName"
    ],
    existing: uniqueMatch(
      targetEntities,
      (item) => sameText(item.code, entityCode),
      `目标 BPM 业务实体代码 ${entityCode}`
    )
  });
  changes.push(entity);

  const pages: PlannedRecord[] = [];
  for (const [index, sourcePage] of sourcePages.entries()) {
    const pcUrl = optionalRequiredString(sourcePage.pcUrl);
    if (!pcUrl) {
      const issue = bpmBlockingIssue(
        "conPage",
        "pcUrl",
        stringField(sourcePage, "id") ?? null,
        "invalid",
        "源 BPM 页面缺少 pcUrl"
      );
      const blocked = blockedRecord("conPage", `page[${index}]`, issue);
      pages.push(blocked);
      changes.push(blocked);
      continue;
    }
    const pageName = optionalRequiredString(sourcePage.name);
    const pageNameError = pageName ? bpmNameLengthError("页面", pageName) : undefined;
    if (pageNameError) {
      const blocked = blockedRecord(
        "conPage",
        pcUrl,
        bpmBlockingIssue("conPage", "name", pageName!, "invalid", pageNameError)
      );
      pages.push(blocked);
      changes.push(blocked);
      continue;
    }
    const pageMatch = childMatch(
      targetPages,
      (item) => sameText(item.pcUrl, pcUrl),
      "conPage",
      "pcUrl",
      pcUrl,
      `目标 BPM 页面 ${pcUrl}`
    );
    if (pageMatch.issue) {
      const blocked = blockedRecord("conPage", pcUrl, pageMatch.issue);
      pages.push(blocked);
      changes.push(blocked);
      continue;
    }
    const page = planRecord({
      resource: "conPage",
      key: pcUrl,
      source: sourcePage,
      fields: pageFields,
      extra: { businessModuleId: module.id },
      compareFields: [...pageFields, "businessModuleId"],
      existing: pageMatch.record
    });
    pages.push(page);
    changes.push(page);
  }

  const interfaces: PlannedRecord[] = [];
  for (const [index, sourceInterface] of sourceInterfaces.entries()) {
    const url = optionalRequiredString(sourceInterface.url);
    if (!url) {
      const issue = bpmBlockingIssue(
        "conInterface",
        "url",
        stringField(sourceInterface, "id") ?? null,
        "invalid",
        "源 BPM 接口缺少 url"
      );
      const blocked = blockedRecord("conInterface", `interface[${index}]`, issue);
      interfaces.push(blocked);
      changes.push(blocked);
      continue;
    }
    const interfaceName = optionalRequiredString(sourceInterface.name);
    const interfaceNameError = interfaceName
      ? bpmNameLengthError("接口", interfaceName)
      : undefined;
    if (interfaceNameError) {
      const blocked = blockedRecord(
        "conInterface",
        url,
        bpmBlockingIssue("conInterface", "name", interfaceName!, "invalid", interfaceNameError)
      );
      interfaces.push(blocked);
      changes.push(blocked);
      continue;
    }
    const interfaceType = optionalRequiredString(sourceInterface.interfaceType);
    if (!interfaceType) {
      const issue = bpmBlockingIssue(
        "conInterface",
        "interfaceType",
        url,
        "invalid",
        `源 BPM 接口 ${url} 缺少 interfaceType`
      );
      const blocked = blockedRecord("conInterface", url, issue);
      interfaces.push(blocked);
      changes.push(blocked);
      continue;
    }
    const interfaceMatch = childMatch(
      targetInterfaces,
      (target) => sameText(target.url, url),
      "conInterface",
      "url",
      url,
      `目标 BPM 接口 ${url}`
    );
    if (interfaceMatch.issue) {
      const blocked = blockedRecord("conInterface", `${interfaceType}:${url}`, interfaceMatch.issue);
      interfaces.push(blocked);
      changes.push(blocked);
      continue;
    }
    const item = planRecord({
      resource: "conInterface",
      key: `${interfaceType}:${url}`,
      source: sourceInterface,
      fields: interfaceFields,
      extra: { businessModuleId: module.id },
      compareFields: [...interfaceFields, "businessModuleId"],
      existing: interfaceMatch.record
    });
    interfaces.push(item);
    changes.push(item);
  }

  const flowPlan = planRecord({
    resource: "conFlowType",
    key: flowCode,
    source: sourceFlow,
    fields: flowFields,
    extra: { businessEntityId: entity.id },
    compareFields: [...flowFields, "businessEntityId"],
    existing: uniqueMatch(
      targetFlows,
      (item) => sameText(item.code, flowCode),
      `目标 BPM 流程代码 ${flowCode}`
    )
  });
  changes.push(flowPlan);

  const safePages = pages.filter(isWritablePlan);
  const safeInterfaces = interfaces.filter(isWritablePlan);
  const relationsAdded =
    (await countMissingRelations(
      targetClient,
      "conEntityPage",
      requiredPlanId(entity),
      safePages.map(requiredPlanId),
      entity.action === "create"
    )) +
    (await countMissingRelations(
      targetClient,
      "conEntityInterface",
      requiredPlanId(entity),
      safeInterfaces.map(requiredPlanId),
      entity.action === "create"
    ));

  return {
    changes: changes.map(toResourceChange),
    extraSummary: { relationsAdded },
    details: { flow: { code: flowCode, name: flowName, entityCode }, relationsAdded },
    appliedExtra: relationsAdded > 0
  };
}

async function applyBpmChanges(
  _writable: ResourcePlanChange[],
  client: ResourceClient,
  context: ResourceApplyContext
): Promise<void> {
  const changes = context.plan.changes;
  const module = findChange(changes, "conBusinessModule");
  const entity = findChange(changes, "conBusinessEntity");
  const flow = findChange(changes, "conFlowType");
  const safePages = changes.filter((change) => change.resource === "conPage" && isSafeChange(change));
  const safeInterfaces = changes.filter((change) => change.resource === "conInterface" && isSafeChange(change));

  await applyChange(client, module, context.recorder);
  setChangeField(entity, "businessModuleId", requiredChangeId(module));
  await applyChange(client, entity, context.recorder);
  for (const page of safePages) {
    setChangeField(page, "businessModuleId", requiredChangeId(module));
    await applyChange(client, page, context.recorder);
  }
  for (const item of safeInterfaces) {
    setChangeField(item, "businessModuleId", requiredChangeId(module));
    await applyChange(client, item, context.recorder);
  }
  setChangeField(flow, "businessEntityId", requiredChangeId(entity));
  await applyChange(client, flow, context.recorder);

  await addMissingRelations(
    client,
    "conEntityPage",
    requiredChangeId(entity),
    safePages.map(requiredChangeId),
    context.recorder
  );
  await addMissingRelations(
    client,
    "conEntityInterface",
    requiredChangeId(entity),
    safeInterfaces.map(requiredChangeId),
    context.recorder
  );
}

async function verifyBpmChanges(
  client: ResourceClient,
  context: ResourceVerifyContext
): Promise<boolean> {
  const changes = context.plan.changes;
  const entity = findChange(changes, "conBusinessEntity");
  const flow = findChange(changes, "conFlowType");
  const entityId = requiredChangeId(entity);
  const safeChanges = changes.filter(isSafeChange);
  const safePages = changes.filter((change) => change.resource === "conPage" && isSafeChange(change));
  const safeInterfaces = changes.filter((change) => change.resource === "conInterface" && isSafeChange(change));

  const pageIds = new Set((await client.getChildren("conEntityPage", entityId)).map((item) => item.id));
  const interfaceIds = new Set((await client.getChildren("conEntityInterface", entityId)).map((item) => item.id));
  const resources = new Map<string, RecordValue[]>();
  for (const resource of new Set(safeChanges.map((item) => item.resource).filter((value): value is string => typeof value === "string"))) {
    resources.set(resource, (await client.findByPage(resource)).rows);
  }
  const recordsMatch = safeChanges.every((change) => {
    const actual = resources.get(change.resource ?? "")?.find((item) => item.id === change.id);
    return actual !== undefined && Object.entries(change.desired ?? {}).every(
      ([field, value]) => JSON.stringify(actual[field]) === JSON.stringify(value)
    );
  });
  const flows = resources.get("conFlowType") ?? [];
  return (
    recordsMatch &&
    safePages.every((item) => pageIds.has(item.id)) &&
    safeInterfaces.every((item) => interfaceIds.has(item.id)) &&
    flows.some((item) => sameText(item.code, flow.key) && item.businessEntityId === entityId)
  );
}

function planRecord(options: {
  resource: string;
  key: string;
  source: RecordValue;
  fields: string[];
  compareFields?: string[];
  extra?: RecordValue;
  existing?: RecordValue | undefined;
}): PlannedRecord {
  const desired = copyFields(options.source, options.fields);
  Object.assign(desired, options.extra ?? {});
  const compareFields = options.compareFields ?? options.fields;
  const changedFields = options.existing
    ? compareFields.filter(
        (field) => JSON.stringify(options.existing![field]) !== JSON.stringify(desired[field])
      )
    : compareFields.filter((field) => field in desired);
  const action: SyncAction = options.existing
    ? changedFields.length === 0 ? "unchanged" : "update"
    : "create";
  const existingId = options.existing ? requiredString(options.existing.id, `${options.resource} 缺少 ID`) : undefined;
  const id = existingId ?? `<${options.resource}:${options.key}>`;
  return {
    resource: options.resource,
    key: options.key,
    action,
    changedFields,
    desired,
    before: options.existing ?? null,
    id
  };
}

async function applyChange(
  client: ResourceClient,
  change: ResourcePlanChange,
  recorder?: OperationRecorder
): Promise<void> {
  if (change.action === "blocked" || change.action === "unchanged") return;
  if (!change.desired) throw new CliError(`${change.resource} 缺少待写入数据`);
  const resource = requiredString(change.resource, "BPM 变更缺少资源名");
  const saved = await client.save(
    resource,
    change.action === "update" ? { ...change.desired, id: requiredChangeId(change) } : change.desired
  );
  change.id = requiredString(saved.id, `${resource}/save 未返回 ID`);
  if (change.action === "create" && recorder) {
    await recorder.recordAction({
      type: "create-entity",
      service: "sei-bpm",
      resource,
      entityId: change.id,
      expected: change.desired,
      deleteMethod: "DELETE"
    });
  }
}

function findChange(changes: ResourcePlanChange[], resource: string): ResourcePlanChange {
  const change = changes.find((item) => item.resource === resource);
  if (!change) throw new CliError(`BPM 计划缺少 ${resource} 变更`);
  return change;
}

function requiredChangeId(change: ResourcePlanChange): string {
  if (typeof change.id !== "string" || change.id.trim() === "") {
    throw new CliError(`${change.resource} 缺少目标 ID`);
  }
  return change.id;
}

function setChangeField(change: ResourcePlanChange, field: string, value: unknown): void {
  if (!change.desired) throw new CliError(`${change.resource} 缺少待写入数据`);
  change.desired[field] = value;
}

type SafePlannedRecord = PlannedRecord & {
  action: Exclude<SyncAction, "blocked">;
  desired: RecordValue;
  id: string;
};

function isWritablePlan(plan: PlannedRecord): plan is SafePlannedRecord {
  return plan.action !== "blocked" && plan.desired !== null && plan.id !== null;
}

function isSafeChange(change: ResourcePlanChange): change is ResourcePlanChange & { id: string; desired: RecordValue } {
  return change.action !== "blocked" && change.desired !== null && typeof change.id === "string";
}

function requiredPlanId(plan: PlannedRecord): string {
  if (plan.id === null) throw new CliError(`${plan.resource} 缺少目标 ID`);
  return plan.id;
}

function blockedRecord(
  resource: string,
  key: string,
  issue: BpmBlockingIssue
): PlannedRecord {
  return {
    resource,
    key,
    action: "blocked",
    changedFields: [],
    desired: null,
    before: null,
    id: null,
    blockingIssues: [issue]
  };
}

function toResourceChange(plan: PlannedRecord): ResourcePlanChange {
  return {
    key: plan.key,
    action: plan.action,
    changedFields: plan.changedFields,
    before: plan.before,
    desired: plan.desired,
    ...(plan.blockingIssues
      ? {
          blockingIssues: plan.blockingIssues.map(toBlockingIssue)
        }
      : {}),
    resource: plan.resource,
    id: plan.id
  };
}

function toBlockingIssue(issue: BpmBlockingIssue): BlockingIssue {
  return {
    resource: issue.resource,
    field: issue.identityField,
    identityField: issue.identityField,
    value: issue.value,
    reason: issue.reason,
    message: issue.message
  };
}

function bpmBlockingIssue(
  resource: string,
  identityField: string,
  value: string | null,
  reason: BpmBlockingIssue["reason"],
  message: string
): BpmBlockingIssue {
  return { resource, identityField, value, reason, message };
}

function childMatch(
  records: RecordValue[],
  predicate: (record: RecordValue) => boolean,
  resource: string,
  identityField: string,
  value: string,
  label: string
): { record?: RecordValue; issue?: BpmBlockingIssue } {
  const matches = records.filter(predicate);
  if (matches.length > 1) {
    return {
      issue: bpmBlockingIssue(
        resource,
        identityField,
        value,
        "ambiguous",
        `${label}不唯一（匹配 ${matches.length} 条）`
      )
    };
  }
  return matches[0] ? { record: matches[0] } : {};
}

function selectFlow(
  flows: RecordValue[],
  entities: RecordValue[],
  selector: string
): RecordValue {
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = flows.filter((flow) => {
    if (sameText(flow.code, normalized) || sameText(flow.name, normalized)) return true;
    const entity = entities.find((item) => item.id === flow.businessEntityId);
    return entity !== undefined && (sameText(entity.code, normalized) || sameText(entity.name, normalized));
  });
  if (matches.length === 0) throw new CliError(`源环境未找到 BPM 流程：${selector}`);
  if (matches.length > 1) throw new CliError(`源环境 BPM 流程不唯一：${selector}（匹配 ${matches.length} 条）`);
  return matches[0]!;
}

function uniqueById(records: RecordValue[], id: string, label: string): RecordValue {
  const matches = records.filter((item) => item.id === id);
  if (matches.length !== 1) throw new CliError(`${label}无法唯一确定：${id}`);
  return matches[0]!;
}

function uniqueMatch(
  records: RecordValue[],
  predicate: (record: RecordValue) => boolean,
  label: string
): RecordValue | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new CliError(`${label}不唯一（匹配 ${matches.length} 条）`);
  return matches[0];
}

async function addMissingRelations(
  client: ResourceClient,
  resource: "conEntityPage" | "conEntityInterface",
  parentId: string,
  childIds: string[],
  recorder?: OperationRecorder
): Promise<number> {
  const existing = new Set(
    (await client.getChildren(resource, parentId))
      .map((item) => stringField(item, "id"))
      .filter((id): id is string => Boolean(id))
  );
  const missing = childIds.filter((id) => !existing.has(id));
  await client.insertRelations(resource, parentId, missing);
  if (missing.length > 0 && recorder) {
    await recorder.recordAction({
      type: "assign-relations",
      service: "sei-bpm",
      resource,
      parentId,
      childIds: missing
    });
  }
  return missing.length;
}

async function countMissingRelations(
  client: ResourceClient,
  resource: "conEntityPage" | "conEntityInterface",
  parentId: string,
  childIds: string[],
  parentIsNew: boolean
): Promise<number> {
  if (parentIsNew) return childIds.length;
  const existing = new Set(
    (await client.getChildren(resource, parentId))
      .map((item) => stringField(item, "id"))
      .filter((id): id is string => Boolean(id))
  );
  return childIds.filter((id) => !existing.has(id)).length;
}

function copyFields(source: RecordValue, fields: string[]): RecordValue {
  const result: RecordValue = {};
  for (const field of fields) if (field in source) result[field] = source[field];
  return result;
}

function sameText(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase();
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CliError(message);
  return value;
}

function optionalRequiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
