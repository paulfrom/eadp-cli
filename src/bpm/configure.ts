import { CliError } from "../errors.js";
import { BpmClient, stringField } from "./client.js";
import type {
  BpmConfigureResult,
  BpmFlowDefinition,
  BpmFlowResult,
  BpmProjectDefinition,
  ResourceResult
} from "./schema.js";

export async function configureBpmProject(options: {
  client: BpmClient;
  definition: BpmProjectDefinition;
  flows: BpmFlowDefinition[];
  environment: string;
  apply: boolean;
}): Promise<BpmConfigureResult> {
  if (!options.apply) {
    return createPreview(options);
  }

  const module = await ensureResource(
    options.client,
    "conBusinessModule",
    (item) =>
      stringField(item, "code") === options.definition.businessModule.code ||
      stringField(item, "serviceName") === options.definition.businessModule.serviceName,
    {
      code: options.definition.businessModule.code,
      name: options.definition.businessModule.name,
      serviceName: options.definition.businessModule.serviceName,
      apiBaseAddress: null,
      webBaseAddress: options.definition.businessModule.webBaseAddress ?? null,
      internalModule: true,
      frozen: false,
      rank: 0
    },
    options.definition.businessModule.name
  );

  const flowResults: BpmFlowResult[] = [];
  for (const flow of options.flows) {
    flowResults.push(
      await configureFlow(options.client, module.id, flow)
    );
  }

  return {
    environment: options.environment,
    projectPath: options.definition.projectPath,
    sourcePath: options.definition.sourcePath,
    applied: true,
    businessModule: module,
    flows: flowResults
  };
}

async function configureFlow(
  client: BpmClient,
  moduleId: string,
  flow: BpmFlowDefinition
): Promise<BpmFlowResult> {
  const entity = await ensureResource(
    client,
    "conBusinessEntity",
    (item) => stringField(item, "code") === flow.entity.code,
    {
      name: flow.entity.name,
      code: flow.entity.code,
      depict: `${flow.name}业务实体`,
      businessModuleId: moduleId,
      serviceName: flow.entity.serviceName,
      conditionPropertiesAll: `${flow.entity.serviceName}/propertiesAllExplain`,
      conditionPropertiesValue: `${flow.entity.serviceName}/propertiesAndValues`,
      conditionStatusReset: `${flow.entity.serviceName}/resetState`,
      pcLookUrl: flow.entity.pcLookUrl ?? null,
      phoneLookUrl: null,
      rank: 0,
      frozen: false
    },
    flow.entity.name
  );

  const pages: ResourceResult[] = [];
  for (const [index, page] of flow.pages.entries()) {
    pages.push(
      await ensureResource(
        client,
        "conPage",
        (item) =>
          stringField(item, "businessModuleId") === moduleId &&
          stringField(item, "pcUrl") === page.pcUrl,
        {
          name: page.name,
          pcUrl: page.pcUrl,
          pcLookUrl: null,
          phoneUrl: null,
          outsideInterface: null,
          depict: null,
          frozen: false,
          rank: index,
          businessModuleId: moduleId
        },
        page.name
      )
    );
  }

  const interfaces: ResourceResult[] = [];
  for (const [index, item] of flow.interfaces.entries()) {
    interfaces.push(
      await ensureResource(
        client,
        "conInterface",
        (existing) =>
          stringField(existing, "businessModuleId") === moduleId &&
          stringField(existing, "url") === item.url &&
          stringField(existing, "interfaceType") === item.interfaceType,
        {
          name: item.name,
          url: item.url,
          compensationUrl: null,
          depict: null,
          interfaceType: item.interfaceType,
          frozen: false,
          rank: index,
          businessModuleId: moduleId,
          param: null
        },
        item.name
      )
    );
  }

  const pageRelationsAdded = await ensureRelations(
    client,
    "conEntityPage",
    entity.id,
    pages.map((item) => item.id)
  );
  const interfaceRelationsAdded = await ensureRelations(
    client,
    "conEntityInterface",
    entity.id,
    interfaces.map((item) => item.id)
  );

  const flowType = await ensureResource(
    client,
    "conFlowType",
    (item) => stringField(item, "code") === flow.code,
    {
      name: flow.name,
      code: flow.code,
      depict: `${flow.name}流程类型`,
      businessEntityId: entity.id,
      pcLookUrl: null,
      phoneLookUrl: null,
      rank: 0,
      frozen: false,
      realtimeNodeStatus: false
    },
    flow.name
  );

  const verified = await verifyFlow(
    client,
    entity.id,
    pages.map((item) => item.id),
    interfaces.map((item) => item.id),
    flow.code
  );
  if (!verified) {
    throw new CliError(`BPM 配置回查失败：${flow.name}(${flow.code})`);
  }

  return {
    flow: flow.code,
    entity,
    pages,
    interfaces,
    pageRelationsAdded,
    interfaceRelationsAdded,
    flowType,
    verified
  };
}

async function ensureResource(
  client: BpmClient,
  resource: string,
  matches: (item: Record<string, unknown>) => boolean,
  payload: Record<string, unknown>,
  name: string
): Promise<ResourceResult> {
  const existing = (await client.findByPage(resource)).find(matches);
  if (existing) {
    const id = stringField(existing, "id");
    if (!id) {
      throw new CliError(`${resource} 已存在数据缺少 ID：${name}`);
    }
    return { action: "reused", id, name };
  }
  const created = await client.save(resource, payload);
  return {
    action: "created",
    id: stringField(created, "id")!,
    name: stringField(created, "name") ?? name
  };
}

async function ensureRelations(
  client: BpmClient,
  resource: "conEntityPage" | "conEntityInterface",
  parentId: string,
  desiredIds: string[]
): Promise<number> {
  const existingIds = new Set(
    (await client.getChildren(resource, parentId))
      .map((item) => stringField(item, "id"))
      .filter((id): id is string => Boolean(id))
  );
  const missing = desiredIds.filter((id) => !existingIds.has(id));
  await client.insertRelations(resource, parentId, missing);
  return missing.length;
}

async function verifyFlow(
  client: BpmClient,
  entityId: string,
  pageIds: string[],
  interfaceIds: string[],
  flowCode: string
): Promise<boolean> {
  const pages = await client.getChildren("conEntityPage", entityId);
  const interfaces = await client.getChildren("conEntityInterface", entityId);
  const flowTypes = await client.findByPage("conFlowType");
  const actualPageIds = new Set(pages.map((item) => stringField(item, "id")));
  const actualInterfaceIds = new Set(
    interfaces.map((item) => stringField(item, "id"))
  );
  return (
    pageIds.every((id) => actualPageIds.has(id)) &&
    interfaceIds.every((id) => actualInterfaceIds.has(id)) &&
    flowTypes.some(
      (item) =>
        stringField(item, "code") === flowCode &&
        stringField(item, "businessEntityId") === entityId
    )
  );
}

function createPreview(options: {
  definition: BpmProjectDefinition;
  flows: BpmFlowDefinition[];
  environment: string;
}): BpmConfigureResult {
  return {
    environment: options.environment,
    projectPath: options.definition.projectPath,
    sourcePath: options.definition.sourcePath,
    applied: false,
    businessModule: {
      action: "planned",
      id: "<运行 --apply 时自动查询或创建>",
      name: options.definition.businessModule.name
    },
    flows: options.flows.map((flow) => ({
      flow: flow.code,
      entity: {
        action: "planned",
        id: "<自动查询或创建>",
        name: flow.entity.name
      },
      pages: flow.pages.map((page) => ({
        action: "planned",
        id: "<自动查询或创建>",
        name: page.name
      })),
      interfaces: flow.interfaces.map((item) => ({
        action: "planned",
        id: "<自动查询或创建>",
        name: item.name
      })),
      pageRelationsAdded: 0,
      interfaceRelationsAdded: 0,
      flowType: {
        action: "planned",
        id: "<自动查询或创建>",
        name: flow.name
      },
      verified: false
    }))
  };
}
