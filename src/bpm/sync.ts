import { CliError } from "../errors.js";
import { BpmClient, stringField } from "./client.js";

type RecordValue = Record<string, unknown>;
type SyncAction = "create" | "update" | "unchanged";

interface PlannedRecord {
  resource: string;
  key: string;
  action: SyncAction;
  changedFields: string[];
  desired: RecordValue;
  id: string;
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

export interface BpmSyncResult {
  kind: "eadp.bpm.sync.v1";
  sourceEnvironment: string;
  targetEnvironment: string;
  flow: { code: string; name: string; entityCode: string };
  applied: boolean;
  summary: { create: number; update: number; unchanged: number; relationsAdded: number };
  changes: PlannedRecord[];
  verified: boolean;
}

export async function syncBpmFlow(options: {
  sourceClient: BpmClient;
  targetClient: BpmClient;
  sourceEnvironment: string;
  targetEnvironment: string;
  selector: string;
  apply: boolean;
}): Promise<BpmSyncResult> {
  const sourceFlowTypes = await options.sourceClient.findByPage("conFlowType");
  const sourceEntities = await options.sourceClient.findByPage("conBusinessEntity");
  const sourceFlow = selectFlow(sourceFlowTypes, sourceEntities, options.selector);
  const sourceEntity = uniqueById(
    sourceEntities,
    requiredString(sourceFlow.businessEntityId, "源 BPM 流程缺少 businessEntityId"),
    "源 BPM 业务实体"
  );
  const sourceModules = await options.sourceClient.findByPage("conBusinessModule");
  const sourceModule = uniqueById(
    sourceModules,
    requiredString(sourceEntity.businessModuleId, "源 BPM 业务实体缺少 businessModuleId"),
    "源 BPM 业务模块"
  );
  const sourceEntityId = requiredString(sourceEntity.id, "源 BPM 业务实体缺少 ID");
  const sourcePages = await options.sourceClient.getChildren("conEntityPage", sourceEntityId);
  const sourceInterfaces = await options.sourceClient.getChildren(
    "conEntityInterface",
    sourceEntityId
  );

  const targetModules = await options.targetClient.findByPage("conBusinessModule");
  const targetEntities = await options.targetClient.findByPage("conBusinessEntity");
  const targetPages = await options.targetClient.findByPage("conPage");
  const targetInterfaces = await options.targetClient.findByPage("conInterface");
  const targetFlows = await options.targetClient.findByPage("conFlowType");
  const changes: PlannedRecord[] = [];

  const moduleCode = requiredString(sourceModule.code, "源 BPM 业务模块缺少代码");
  const module = await upsert({
    client: options.targetClient,
    resource: "conBusinessModule",
    key: moduleCode,
    source: sourceModule,
    fields: moduleFields,
    existing: uniqueMatch(
      targetModules,
      (item) => sameText(item.code, moduleCode),
      `目标 BPM 业务模块代码 ${moduleCode}`
    ),
    apply: options.apply
  });
  changes.push(module);

  const entityCode = requiredString(sourceEntity.code, "源 BPM 业务实体缺少代码");
  const entity = await upsert({
    client: options.targetClient,
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
    ),
    apply: options.apply
  });
  changes.push(entity);

  const pages: PlannedRecord[] = [];
  for (const sourcePage of sourcePages) {
    const pcUrl = requiredString(sourcePage.pcUrl, "源 BPM 页面缺少 pcUrl");
    const page = await upsert({
      client: options.targetClient,
      resource: "conPage",
      key: pcUrl,
      source: sourcePage,
      fields: pageFields,
      extra: { businessModuleId: module.id },
      compareFields: [...pageFields, "businessModuleId"],
      existing: uniqueMatch(
        targetPages,
        (item) => sameText(item.businessModuleId, module.id) && sameText(item.pcUrl, pcUrl),
        `目标 BPM 页面 ${pcUrl}`
      ),
      apply: options.apply
    });
    pages.push(page);
    changes.push(page);
  }

  const interfaces: PlannedRecord[] = [];
  for (const sourceInterface of sourceInterfaces) {
    const url = requiredString(sourceInterface.url, "源 BPM 接口缺少 url");
    const interfaceType = requiredString(
      sourceInterface.interfaceType,
      `源 BPM 接口 ${url} 缺少 interfaceType`
    );
    const item = await upsert({
      client: options.targetClient,
      resource: "conInterface",
      key: `${interfaceType}:${url}`,
      source: sourceInterface,
      fields: interfaceFields,
      extra: { businessModuleId: module.id },
      compareFields: [...interfaceFields, "businessModuleId"],
      existing: uniqueMatch(
        targetInterfaces,
        (target) =>
          sameText(target.businessModuleId, module.id) &&
          sameText(target.url, url) &&
          sameText(target.interfaceType, interfaceType),
        `目标 BPM 接口 ${interfaceType}:${url}`
      ),
      apply: options.apply
    });
    interfaces.push(item);
    changes.push(item);
  }

  const flowCode = requiredString(sourceFlow.code, "源 BPM 流程类型缺少代码");
  const flow = await upsert({
    client: options.targetClient,
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
    ),
    apply: options.apply
  });
  changes.push(flow);

  let relationsAdded = 0;
  if (options.apply) {
    relationsAdded += await addMissingRelations(
      options.targetClient,
      "conEntityPage",
      entity.id,
      pages.map((item) => item.id)
    );
    relationsAdded += await addMissingRelations(
      options.targetClient,
      "conEntityInterface",
      entity.id,
      interfaces.map((item) => item.id)
    );
  } else {
    relationsAdded += await countMissingRelations(
      options.targetClient,
      "conEntityPage",
      entity.id,
      pages.map((item) => item.id),
      entity.action === "create"
    );
    relationsAdded += await countMissingRelations(
      options.targetClient,
      "conEntityInterface",
      entity.id,
      interfaces.map((item) => item.id),
      entity.action === "create"
    );
  }

  const verified = options.apply
    ? await verifyTarget(
        options.targetClient,
        entity.id,
        pages,
        interfaces,
        flowCode,
        changes
      )
    : false;
  if (options.apply && !verified) throw new CliError(`BPM 同步写入后回查失败：${flowCode}`);

  return {
    kind: "eadp.bpm.sync.v1",
    sourceEnvironment: options.sourceEnvironment,
    targetEnvironment: options.targetEnvironment,
    flow: {
      code: flowCode,
      name: requiredString(sourceFlow.name, "源 BPM 流程类型缺少名称"),
      entityCode
    },
    applied:
      options.apply &&
      (changes.some((item) => item.action !== "unchanged") || relationsAdded > 0),
    summary: {
      create: changes.filter((item) => item.action === "create").length,
      update: changes.filter((item) => item.action === "update").length,
      unchanged: changes.filter((item) => item.action === "unchanged").length,
      relationsAdded
    },
    changes,
    verified
  };
}

async function upsert(options: {
  client: BpmClient;
  resource: string;
  key: string;
  source: RecordValue;
  fields: string[];
  compareFields?: string[];
  extra?: RecordValue;
  existing?: RecordValue | undefined;
  apply: boolean;
}): Promise<PlannedRecord> {
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
  let id = existingId ?? `<${options.resource}:${options.key}>`;
  if (options.apply && action !== "unchanged") {
    const saved = await options.client.save(
      options.resource,
      existingId ? { ...desired, id: existingId } : desired
    );
    id = requiredString(saved.id, `${options.resource}/save 未返回 ID`);
  }
  return { resource: options.resource, key: options.key, action, changedFields, desired, id };
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
  client: BpmClient,
  resource: "conEntityPage" | "conEntityInterface",
  parentId: string,
  childIds: string[]
): Promise<number> {
  const existing = new Set(
    (await client.getChildren(resource, parentId))
      .map((item) => stringField(item, "id"))
      .filter((id): id is string => Boolean(id))
  );
  const missing = childIds.filter((id) => !existing.has(id));
  await client.insertRelations(resource, parentId, missing);
  return missing.length;
}

async function countMissingRelations(
  client: BpmClient,
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

async function verifyTarget(
  client: BpmClient,
  entityId: string,
  pages: PlannedRecord[],
  interfaces: PlannedRecord[],
  flowCode: string,
  changes: PlannedRecord[]
): Promise<boolean> {
  const pageIds = new Set((await client.getChildren("conEntityPage", entityId)).map((item) => item.id));
  const interfaceIds = new Set(
    (await client.getChildren("conEntityInterface", entityId)).map((item) => item.id)
  );
  const resources = new Map<string, RecordValue[]>();
  for (const resource of new Set(changes.map((item) => item.resource))) {
    resources.set(resource, await client.findByPage(resource));
  }
  const recordsMatch = changes.every((change) => {
    const actual = resources.get(change.resource)?.find((item) => item.id === change.id);
    return actual !== undefined && Object.entries(change.desired).every(
      ([field, value]) => JSON.stringify(actual[field]) === JSON.stringify(value)
    );
  });
  const flows = resources.get("conFlowType") ?? [];
  return (
    recordsMatch &&
    pages.every((item) => pageIds.has(item.id)) &&
    interfaces.every((item) => interfaceIds.has(item.id)) &&
    flows.some((item) => sameText(item.code, flowCode) && item.businessEntityId === entityId)
  );
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
