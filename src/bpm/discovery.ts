import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "../errors.js";
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

export async function discoverBpmProject(projectInput: string): Promise<BpmProjectDefinition> {
  const projectPath = resolve(projectInput);
  await ensureDirectory(projectPath);
  const javaSources = await readJavaSources(projectPath);
  const flows = discoverFlows(javaSources);
  if (flows.length === 0) {
    throw new CliError(
      [
        "未从项目代码中发现包含实际业务逻辑的 BPM 流程。",
        "识别依据：BaseFlowController 的具体实现、Entity 类型、API PATH，以及真实 BPM 回调或 startDefaultFlow 调用。",
        "不会读取 BPM流程配置登记册.md，也不会为仅返回成功的空回调生成配置。"
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

export function selectBpmFlow(
  definition: BpmProjectDefinition,
  selector: string
): BpmFlowDefinition {
  const normalized = selector.trim().toLowerCase();
  const matches = definition.flows.filter(
    (flow) =>
      flow.code.toLowerCase() === normalized ||
      flow.name.toLowerCase() === normalized ||
      flow.entity.code.toLowerCase() === normalized
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new CliError(`流程选择不唯一：${selector}`);
  }
  throw new CliError(
    `未找到流程：${selector}。可选值：${definition.flows
      .map((flow) => `${flow.name}(${flow.code})`)
      .join("、")}`
  );
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
  const startedEntities = discoverStartedEntities(sources);
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
    const startsDefaultFlow = startedEntities.has(entityCode);
    if (callbacks.length === 0 && !startsDefaultFlow) {
      continue;
    }

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

function discoverStartedEntities(sources: JavaSource[]): Set<string> {
  const result = new Set<string>();
  const pattern = /DefaultStartParam\s*\(\s*([\w.]+)\.class\.getName\s*\(\s*\)/g;
  for (const source of sources) {
    for (const match of source.source.matchAll(pattern)) {
      result.add(resolveTypeName(source, match[1]!));
    }
  }
  return result;
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
