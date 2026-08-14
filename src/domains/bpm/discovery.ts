import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "../../errors.js";
import type {
  BpmBusinessModuleDefinition,
  BpmFlowDefinition,
  BpmInterfaceDefinition,
  BpmProjectDefinition
} from "./schema.js";

interface JavaSource {
  path: string;
  source: string;
  packageName?: string;
  typeName?: string;
}

interface DiscoveredCallback {
  methodName: string;
  interfaceType: BpmInterfaceDefinition["interfaceType"];
}

const EVENT_NAMES: Record<string, string> = {
  beforeStartFlow: "流程启动前事件",
  afterStartFlow: "流程启动后事件",
  beforeEndFlow: "流程结束前事件",
  afterEndFlow: "流程结束后事件"
};

export async function discoverBpmProject(
  projectInput: string,
  requestedEntityCode?: string
): Promise<BpmProjectDefinition> {
  const projectPath = resolve(projectInput);
  await ensureDirectory(projectPath);
  const javaSources = await readJavaSources(projectPath);
  const flows = discoverFlows(javaSources);
  if (
    requestedEntityCode &&
    !flows.some((flow) => sameText(flow.entity.code, requestedEntityCode))
  ) {
    const selected = discoverSelectedEntity(javaSources, requestedEntityCode);
    if (selected) flows.push(selected);
  }
  if (flows.length === 0) {
    throw new CliError(
      [
        "未从项目代码中发现 BPM 流程骨架。",
        "识别依据：BaseFlowController 的具体实现、Entity 类型和可解析的 API PATH。",
        "BPM 回调和 startDefaultFlow 调用均为可选，不会读取 BPM流程配置登记册.md。"
      ].join("\n")
    );
  }

  const moduleCode = await discoverModuleCode(projectPath);
  const webBaseAddress = await discoverWebBaseAddress(projectPath);
  const businessModule: BpmBusinessModuleDefinition = {
    code: moduleCode,
    name: moduleCode,
    serviceName: moduleCode,
    ...(webBaseAddress ? { webBaseAddress } : {})
  };
  return { projectPath, sourcePath: projectPath, businessModule, flows };
}

export function resolveBpmEntityCode(
  selector: string,
  remote: {
    flowTypes: Record<string, unknown>[];
    entities: Record<string, unknown>[];
  }
): string {
  const matches = remote.flowTypes.filter((flow) => sameText(stringValue(flow.code), selector));
  if (matches.length > 1) {
    throw new CliError(`远端 BPM 流程类型 code 不唯一：${selector}`);
  }
  if (matches.length === 0) return selector.trim();
  const entity = uniqueRemoteEntityById(
    remote.entities,
    stringValue(matches[0]!.businessEntityId),
    selector
  );
  const entityCode = stringValue(entity.code);
  if (!entityCode) throw new CliError(`远端 BPM Entity 缺少全限定名：${selector}`);
  return entityCode;
}

export function selectBpmFlow(
  definition: BpmProjectDefinition,
  selector: string,
  remote?: {
    flowTypes: Record<string, unknown>[];
    entities: Record<string, unknown>[];
  }
): BpmFlowDefinition {
  const normalized = selector.trim().toLowerCase();
  const entityMatches = definition.flows.filter(
    (flow) => flow.entity.code.toLowerCase() === normalized
  );
  if (entityMatches.length > 1) {
    throw new CliError(`Entity 全限定名不唯一：${selector}`);
  }

  const remoteCodeMatches = (remote?.flowTypes ?? []).filter(
    (flow) => stringValue(flow.code)?.toLowerCase() === normalized
  );
  if (remoteCodeMatches.length > 1) {
    throw new CliError(`远端 BPM 流程类型 code 不唯一：${selector}`);
  }
  const remoteCodeMatch = remoteCodeMatches[0];
  const remoteCodeEntity = remoteCodeMatch
    ? uniqueRemoteEntityById(remote!.entities, stringValue(remoteCodeMatch.businessEntityId), selector)
    : undefined;
  const remoteCodeLocalFlow = remoteCodeEntity
    ? uniqueLocalFlowByEntityCode(definition, stringValue(remoteCodeEntity.code), selector)
    : undefined;

  const entityMatch = entityMatches[0];
  if (entityMatch) {
    const remoteEntities = (remote?.entities ?? []).filter(
      (entity) => stringValue(entity.code)?.toLowerCase() === normalized
    );
    if (remoteEntities.length > 1) {
      throw new CliError(`远端 BPM Entity 全限定名不唯一：${selector}`);
    }
    const existingEntity = remoteEntities[0];
    const boundFlowTypes = existingEntity
      ? (remote?.flowTypes ?? []).filter(
          (flow) => stringValue(flow.businessEntityId) === stringValue(existingEntity.id)
        )
      : [];
    if (boundFlowTypes.length > 1) {
      throw new CliError(`Entity 对应多个远端 BPM 流程类型，请改用流程 code：${selector}`);
    }
    if (remoteCodeLocalFlow && remoteCodeLocalFlow.entity.code !== entityMatch.entity.code) {
      throw new CliError(`选择值同时匹配不同的 Entity 和远端流程 code：${selector}`);
    }
    const existingCode = stringValue(boundFlowTypes[0]?.code);
    return existingCode ? { ...entityMatch, code: existingCode } : entityMatch;
  }

  if (remoteCodeLocalFlow && remoteCodeMatch) {
    return { ...remoteCodeLocalFlow, code: stringValue(remoteCodeMatch.code)! };
  }
  throw new CliError(
    `未找到流程：${selector}。可选 Entity 全限定名：${definition.flows
      .map((flow) => flow.entity.code)
      .join("、")}`
  );
}

function uniqueRemoteEntityById(
  entities: Record<string, unknown>[],
  id: string | undefined,
  selector: string
): Record<string, unknown> {
  if (!id) throw new CliError(`远端 BPM 流程类型缺少 businessEntityId：${selector}`);
  const matches = entities.filter((entity) => stringValue(entity.id) === id);
  if (matches.length !== 1) {
    throw new CliError(`远端 BPM 流程类型无法唯一定位 Entity：${selector}`);
  }
  return matches[0]!;
}

function uniqueLocalFlowByEntityCode(
  definition: BpmProjectDefinition,
  entityCode: string | undefined,
  selector: string
): BpmFlowDefinition {
  if (!entityCode) throw new CliError(`远端 BPM Entity 缺少全限定名：${selector}`);
  const matches = definition.flows.filter(
    (flow) => flow.entity.code.toLowerCase() === entityCode.toLowerCase()
  );
  if (matches.length !== 1) {
    throw new CliError(`项目代码无法按 Entity 全限定名唯一定位流程：${entityCode}`);
  }
  return matches[0]!;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function sameText(value: string | undefined, expected: string): boolean {
  return value?.toLowerCase() === expected.trim().toLowerCase();
}

function discoverSelectedEntity(
  sources: JavaSource[],
  requestedEntityCode: string
): BpmFlowDefinition | undefined {
  const matches = sources.filter(
    (source) =>
      source.typeName !== undefined &&
      `${source.packageName ?? ""}.${source.typeName}`.replace(/^\./, "") === requestedEntityCode
  );
  if (matches.length > 1) {
    throw new CliError(`Entity 全限定名不唯一：${requestedEntityCode}`);
  }
  const entity = matches[0];
  if (!entity || !new RegExp(`\\bclass\\s+${escapeRegExp(entity.typeName!)}\\b`).test(entity.source)) {
    return undefined;
  }

  const types = new Map<string, JavaSource>();
  for (const source of sources) {
    if (!source.typeName) continue;
    types.set(source.typeName, source);
    if (source.packageName) types.set(`${source.packageName}.${source.typeName}`, source);
  }
  const controllers = sources.filter((source) => {
    const declaration = source.source.match(
      /class\s+(\w+Controller)\b[^\{]*\bextends\s+BaseFlowController\s*<\s*([\w.]+)\s*,/
    );
    return declaration?.[2] !== undefined &&
      resolveTypeName(source, declaration[2]) === requestedEntityCode;
  });
  if (controllers.length > 1) {
    throw new CliError(`BPM Entity 对应多个 Controller，无法唯一确定：${requestedEntityCode}`);
  }
  const controller = controllers[0];
  const simple = entity.typeName!;
  const serviceName = controller
    ? discoverServiceName(controller, types) ?? lowerCamel(simple)
    : lowerCamel(simple);
  const name = controller ? discoverBusinessName(controller.source, simple) : simple;
  return {
    name,
    code: requestedEntityCode,
    entity: { name, code: requestedEntityCode, serviceName },
    interfaces: controller
      ? discoverCallbacks(controller.source).map((callback) => ({
          name: `${name}-${EVENT_NAMES[callback.methodName] ?? callback.methodName}`,
          url: `${serviceName}/${callback.methodName}`,
          interfaceType: callback.interfaceType
        }))
      : [],
    pages: []
  };
}

function lowerCamel(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function discoverFlows(sources: JavaSource[]): BpmFlowDefinition[] {
  const types = new Map<string, JavaSource>();
  for (const item of sources) {
    if (item.typeName) {
      types.set(item.typeName, item);
      if (item.packageName) {
        types.set(`${item.packageName}.${item.typeName}`, item);
      }
    }
  }
  const flows: BpmFlowDefinition[] = [];
  const entityCodes = new Set<string>();

  for (const controller of sources) {
    const declaration = controller.source.match(
      /class\s+(\w+Controller)\b[^\{]*\bextends\s+BaseFlowController\s*<\s*([\w.]+)\s*,/
    );
    if (!declaration?.[2]) {
      continue;
    }
    const entityType = declaration[2];
    const entityCode = resolveTypeName(controller, entityType);
    const callbacks = discoverCallbacks(controller.source);

    const serviceName = discoverServiceName(controller, types);
    if (!serviceName) {
      continue;
    }
    if (entityCodes.has(entityCode)) {
      throw new CliError(`BPM Entity 对应多个 Controller，无法唯一确定：${entityCode}`);
    }
    entityCodes.add(entityCode);
    const name = discoverBusinessName(controller.source, simpleName(entityType));
    flows.push({
      name,
      code: entityCode,
      entity: { name, code: entityCode, serviceName },
      interfaces: callbacks.map((callback) => ({
        name: `${name}-${EVENT_NAMES[callback.methodName] ?? callback.methodName}`,
        url: `${serviceName}/${callback.methodName}`,
        interfaceType: callback.interfaceType
      })),
      pages: []
    });
  }
  return flows.sort((left, right) => left.code.localeCompare(right.code));
}

function discoverCallbacks(source: string): DiscoveredCallback[] {
  const methods = new Map<string, DiscoveredCallback>();
  const signature = /public\s+([\w<>, ?\[\].]+?)\s+(\w+)\s*\(([^)]*\bBpmInvokeParams\b[^)]*)\)\s*\{/g;
  for (const match of source.matchAll(signature)) {
    const openingBrace = (match.index ?? 0) + match[0].length - 1;
    const body = readBraceBody(source, openingBrace);
    if (body !== undefined && hasBusinessLogic(body)) {
      const returnType = match[1]!;
      const methodName = match[2]!;
      methods.set(methodName, {
        methodName,
        interfaceType: /\bExecutor\b/.test(returnType) ? "CUSTOM_PERSON" : "EVENT"
      });
    }
  }
  return [...methods.values()];
}

function hasBusinessLogic(body: string): boolean {
  const normalized = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
  const receivers = [...normalized.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*\w+\s*\(/g)]
    .map((match) => match[1]!);
  const nonBusinessReceivers = new Set([
    "ResultData", "ResultDataUtil", "Objects", "StringUtils", "CollectionUtils",
    "super", "params", "invokeParams", "flowInvokeParams", "bpmInvokeParams"
  ]);
  return receivers.some((receiver) => !nonBusinessReceivers.has(receiver));
}

function readBraceBody(source: string, openingBrace: number): string | undefined {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingBrace + 1, index);
      }
    }
  }
  return undefined;
}

function discoverServiceName(controller: JavaSource, types: Map<string, JavaSource>): string | undefined {
  const mapping = controller.source.match(/@RequestMapping\s*\(\s*path\s*=\s*([^,\n)]+)/)?.[1]?.trim();
  const direct = mapping?.match(/^"([^"]+)"$/)?.[1];
  if (direct) {
    return normalizeServiceName(direct);
  }
  const apiName = mapping?.match(/^(\w+)\.PATH$/)?.[1];
  if (!apiName) {
    return undefined;
  }
  const importedApi = controller.source.match(
    new RegExp(`import\\s+([\\w.]+\\.${escapeRegExp(apiName)})\\s*;`)
  )?.[1];
  const api = (importedApi ? types.get(importedApi) : undefined) ?? types.get(apiName);
  const path = api?.source.match(/\bPATH\s*=\s*"([^"]+)"/)?.[1];
  return path ? normalizeServiceName(path) : undefined;
}

function normalizeServiceName(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function discoverBusinessName(source: string, fallback: string): string {
  const description = source.match(/@Tag\s*\([^)]*description\s*=\s*"([^"]+)"/)?.[1]?.trim();
  return description?.replace(/(?:服务|接口)$/u, "").trim() || fallback;
}

function resolveTypeName(source: JavaSource, typeName: string): string {
  if (typeName.includes(".")) {
    return typeName;
  }
  const imported = source.source.match(new RegExp(`import\\s+([\\w.]+\\.${escapeRegExp(typeName)})\\s*;`))?.[1];
  return imported ?? `${source.packageName ?? ""}.${typeName}`.replace(/^\./, "");
}

function simpleName(value: string): string {
  return value.slice(value.lastIndexOf(".") + 1);
}

async function readJavaSources(projectPath: string): Promise<JavaSource[]> {
  const paths = await collectJavaFiles(projectPath);
  return Promise.all(paths.map(async (path) => {
    const source = await readFile(path, "utf8");
    const packageName = source.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
    const typeName = source.match(/\b(?:class|interface)\s+(\w+)/)?.[1];
    return {
      path,
      source,
      ...(packageName ? { packageName } : {}),
      ...(typeName ? { typeName } : {})
    };
  }));
}

async function collectJavaFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if ([".git", "build", "dist", "node_modules", "target"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectJavaFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      result.push(path);
    }
  }
  return result;
}

async function discoverModuleCode(projectPath: string): Promise<string> {
  const settings = await findReadableFile([
    join(projectPath, "backend", "settings.gradle"),
    join(projectPath, "settings.gradle"),
    join(projectPath, "settings.gradle.kts")
  ]);
  if (settings) {
    const source = await readFile(settings, "utf8");
    const match = source.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return basename(projectPath);
}

async function discoverWebBaseAddress(projectPath: string): Promise<string | undefined> {
  const siblingWeb = join(dirname(projectPath), `${basename(projectPath)}-web`, "package.json");
  const packageFile = await findReadableFile([
    join(projectPath, "frontend", "package.json"),
    join(projectPath, "package.json"),
    siblingWeb
  ]);
  if (!packageFile) {
    return undefined;
  }
  try {
    const value = JSON.parse(await readFile(packageFile, "utf8")) as { name?: unknown };
    return typeof value.name === "string" ? value.name : undefined;
  } catch {
    return undefined;
  }
}

async function findReadableFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // 继续检查下一个项目约定路径。
    }
  }
  return undefined;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new CliError(`项目路径不是目录：${path}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`项目路径不存在或不可读取：${path}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
