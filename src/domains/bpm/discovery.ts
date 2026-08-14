import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "../../errors.js";
import type {
  BpmBusinessModuleDefinition,
  BpmFlowDefinition,
  BpmInterfaceDefinition,
  BpmProjectDefinition
} from "./schema.js";
import { assertBpmNameLength } from "./naming.js";

interface JavaSource {
  path: string;
  source: string;
  packageName?: string;
  typeName?: string;
}

interface DiscoveredCallback {
  methodName: string;
  name: string;
  interfaceType: BpmInterfaceDefinition["interfaceType"];
}

interface RouteSource {
  path: string;
  source: string;
}

interface ParsedRoute {
  start: number;
  end: number;
  path: string;
  name?: string;
  title?: string;
  component?: string;
  componentDefined: boolean;
  source: string;
}

const ROUTE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const ROUTE_DIRECTORY_NAMES = new Set(["router", "routers", "route", "routes"]);
const ROUTE_FILE_PATTERN = /^(?:router|routers|route|routes)(?:\.config)?$/u;
const WORK_PAGE_TERMS = /(?:申请|审批|流程|办理|处理|提交|审核|表单|apply|approval|approve|workflow|flow|audit|review|handle|form)/iu;

export async function discoverBpmProject(
  projectInput: string,
  requestedEntityCode?: string
): Promise<BpmProjectDefinition> {
  const projectPath = resolve(projectInput);
  await ensureDirectory(projectPath);
  const javaSources = await readJavaSources(projectPath);
  const routeSources = await readRouteSources(projectPath);
  const flows = discoverFlows(javaSources, routeSources);
  if (
    requestedEntityCode &&
    !flows.some((flow) => sameText(flow.entity.code, requestedEntityCode))
  ) {
    const selected = discoverSelectedEntity(javaSources, requestedEntityCode, routeSources);
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
  const definition = { projectPath, sourcePath: projectPath, businessModule, flows };
  assertBpmNameLengths(definition);
  return definition;
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
  requestedEntityCode: string,
  routeSources: RouteSource[]
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
  const name = controller
    ? discoverBusinessName(controller.source, simple)
    : discoverEntityName(entity.source, simple);
  const callbacks = controller ? discoverCallbacks(controller.source) : [];
  return {
    name,
    code: requestedEntityCode,
    entity: { name, code: requestedEntityCode, serviceName },
    interfaces: callbacks.map((callback) => ({
      name: callback.name,
      url: `${serviceName}/${callback.methodName}`,
      interfaceType: callback.interfaceType
    })),
    pages: discoverPages(routeSources, { name, entityCode: requestedEntityCode, serviceName })
  };
}

function lowerCamel(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function discoverFlows(sources: JavaSource[], routeSources: RouteSource[]): BpmFlowDefinition[] {
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
    const serviceName = discoverServiceName(controller, types);
    if (!serviceName) {
      continue;
    }
    if (entityCodes.has(entityCode)) {
      throw new CliError(`BPM Entity 对应多个 Controller，无法唯一确定：${entityCode}`);
    }
    entityCodes.add(entityCode);
    const name = discoverBusinessName(controller.source, simpleName(entityType));
    const interfaces = discoverCallbacks(controller.source).map((callback) => ({
      name: callback.name,
      url: `${serviceName}/${callback.methodName}`,
      interfaceType: callback.interfaceType
    }));
    flows.push({
      name,
      code: entityCode,
      entity: { name, code: entityCode, serviceName },
      interfaces,
      pages: discoverPages(routeSources, { name, entityCode, serviceName })
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
      const name = discoverCallbackName(source, match.index ?? 0, methodName);
      if (!name) {
        continue;
      }
      methods.set(methodName, {
        methodName,
        name,
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
  const classIndex = source.search(/\bclass\s+\w+Controller\b/u);
  const beforeClass = classIndex >= 0 ? source.slice(0, classIndex) : source;
  const comment = lastJavadocText(beforeClass);
  if (comment) {
    return comment;
  }
  const tag = lastAnnotationValue(beforeClass, "Tag", "description");
  return tag?.replace(/(?:服务|接口)$/u, "").trim() || fallback;
}

function discoverEntityName(source: string, fallback: string): string {
  const classIndex = source.search(/\bclass\s+\w+\b/u);
  const beforeClass = classIndex >= 0 ? source.slice(0, classIndex) : source;
  return lastJavadocText(beforeClass) ?? fallback;
}

function discoverCallbackName(
  source: string,
  methodIndex: number,
  methodName: string
): string | undefined {
  const documentation = methodDocumentationRegion(source, methodIndex);
  const javadoc = lastJavadocText(documentation);
  if (javadoc && !sameText(javadoc, methodName)) {
    return javadoc;
  }

  const operationSummary = lastAnnotationValue(documentation, "Operation", "summary");
  if (operationSummary && !sameText(operationSummary, methodName)) {
    return operationSummary;
  }
  const operationDescription = lastAnnotationValue(documentation, "Operation", "description");
  if (operationDescription && !sameText(operationDescription, methodName)) {
    return operationDescription;
  }

  const comment = lastInlineCommentText(documentation);
  return comment && !sameText(comment, methodName) ? comment : undefined;
}

function methodDocumentationRegion(source: string, methodIndex: number): string {
  const classIndex = source.search(/\bclass\s+\w+Controller\b/u);
  const classBodyStart = classIndex >= 0 ? source.indexOf("{", classIndex) + 1 : 0;
  const beforeMethod = source.slice(0, methodIndex);
  const previousMethodEnd = beforeMethod.lastIndexOf("}");
  const start = Math.max(classBodyStart, previousMethodEnd + 1);
  return source.slice(start, methodIndex);
}

function lastJavadocText(source: string): string | undefined {
  const matches = [...source.matchAll(/\/\*\*([\s\S]*?)\*\//gu)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const text = cleanDocumentationText(matches[index]![1]!);
    if (text) return text;
  }
  return undefined;
}

function lastInlineCommentText(source: string): string | undefined {
  const matches = [...source.matchAll(/\/\*(?!\*)([\s\S]*?)\*\/|\/\/([^\r\n]*)/gu)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const text = cleanDocumentationText(match[1] ?? match[2] ?? "");
    if (text) return text;
  }
  return undefined;
}

function cleanDocumentationText(value: string): string | undefined {
  const text = value
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
    .filter((line) => line && !line.startsWith("@"))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return text || undefined;
}

function lastAnnotationValue(
  source: string,
  annotation: string,
  property: string
): string | undefined {
  const pattern = new RegExp(`@${escapeRegExp(annotation)}\\s*\\(([\\s\\S]*?)\\)`, "gu");
  const matches = [...source.matchAll(pattern)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const value = annotationStringValue(matches[index]![1]!, property);
    if (value) return value;
  }
  return undefined;
}

function annotationStringValue(source: string, property: string): string | undefined {
  const pattern = new RegExp(
    `\\b${escapeRegExp(property)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
    "u"
  );
  const match = source.match(pattern);
  return match?.[2]?.trim() || undefined;
}

interface FlowPageMatchContext {
  name: string;
  entityCode: string;
  serviceName: string;
}

function discoverPages(
  routeSources: RouteSource[],
  flow: FlowPageMatchContext
): BpmProjectDefinition["flows"][number]["pages"] {
  const pages = new Map<string, BpmProjectDefinition["flows"][number]["pages"][number]>();
  for (const routeSource of routeSources) {
    for (const route of parseRouteObjects(routeSource.source)) {
      if (!routeHasPageEvidence(route) || !routeMatchesFlow(route, flow)) {
        continue;
      }
      const name = route.title ?? route.name ?? flow.name;
      if (!pages.has(route.path)) {
        pages.set(route.path, { name, pcUrl: route.path });
      }
    }
  }
  return [...pages.values()];
}

function routeHasPageEvidence(route: ParsedRoute): boolean {
  return Boolean(
    route.name ||
    route.title ||
    route.componentDefined
  );
}

function routeMatchesFlow(route: ParsedRoute, flow: FlowPageMatchContext): boolean {
  const businessText = [route.name, route.title].filter((value): value is string => Boolean(value));
  const routeText = [route.path, route.name, route.title, route.component]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const businessKeys = [
    flow.name,
    stripBusinessSuffix(flow.name),
    simpleName(flow.entityCode),
    stripBusinessSuffix(simpleName(flow.entityCode))
  ];
  if (businessKeys.some((key) => key.length >= 2 && includesRouteText(businessText.join(" "), key))) {
    return true;
  }

  const technicalKeys = [flow.serviceName, simpleName(flow.entityCode)]
    .map((value) => normalizeRouteText(value))
    .filter((value) => value.length >= 2);
  const normalizedRouteText = normalizeRouteText(routeText);
  return technicalKeys.some((key) => normalizedRouteText.includes(key)) && WORK_PAGE_TERMS.test(routeText);
}

function stripBusinessSuffix(value: string): string {
  return value.replace(/(?:流程|服务|接口|业务|申请单|页面|工作台)$/u, "").trim();
}

function includesRouteText(text: string, value: string): boolean {
  return normalizeRouteText(text).includes(normalizeRouteText(value));
}

function normalizeRouteText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_./\\:-]+/gu, "");
}

function parseRouteObjects(source: string): ParsedRoute[] {
  const spans = findObjectSpans(source);
  const routes: ParsedRoute[] = [];
  for (const span of spans) {
    const path = readDirectStringProperty(source, span.start, span.end, "path");
    if (!path) continue;
    const routeSource = source.slice(span.start, span.end + 1);
    const name = readDirectStringProperty(source, span.start, span.end, "name");
    const title = readDirectStringProperty(source, span.start, span.end, "title");
    const componentProperty = readDirectProperty(source, span.start, span.end, "component");
    const component = componentProperty.value;
    routes.push({
      start: span.start,
      end: span.end,
      path,
      ...(name ? { name } : {}),
      ...(title ? { title } : {}),
      ...(component ? { component } : {}),
      componentDefined: componentProperty.found,
      source: routeSource
    });
  }

  const resolved = new Map<number, string | undefined>();
  return routes
    .map((route) => {
      const path = resolveRoutePath(route, routes, resolved);
      return path ? { ...route, path } : undefined;
    })
    .filter((route): route is ParsedRoute => route !== undefined);
}

function resolveRoutePath(
  route: ParsedRoute,
  routes: ParsedRoute[],
  resolved: Map<number, string | undefined>
): string | undefined {
  if (resolved.has(route.start)) {
    return resolved.get(route.start);
  }
  const parent = routes
    .filter((candidate) => candidate.start < route.start && candidate.end > route.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  const parentPath = parent ? resolveRoutePath(parent, routes, resolved) : undefined;
  const value = combineRoutePath(parentPath, route.path);
  resolved.set(route.start, value);
  return value;
}

function combineRoutePath(parent: string | undefined, child: string): string | undefined {
  const value = child.trim();
  if (!value) return undefined;
  if (value.startsWith("/")) return normalizeRoutePath(value);
  return normalizeRoutePath(parent ? `${parent}/${value}` : value);
}

function normalizeRoutePath(value: string): string | undefined {
  const path = value.trim().split(/[?#]/u, 1)[0]!.trim();
  if (!path || path === "*" || path === "/*" || /^https?:\/\//iu.test(path)) {
    return undefined;
  }
  return `/${path.replace(/^\/+|\/+$/gu, "")}` || "/";
}

function findObjectSpans(source: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    if (isQuote(source[index])) {
      index = readQuotedString(source, index)?.next ?? source.length;
      continue;
    }
    if (source[index] === "{") {
      starts.push(index);
    } else if (source[index] === "}") {
      const start = starts.pop();
      if (start !== undefined) spans.push({ start, end: index });
    }
    index += 1;
  }
  return spans.sort((left, right) => left.start - right.start);
}

function readDirectStringProperty(
  source: string,
  start: number,
  end: number,
  property: string
): string | undefined {
  const result = readDirectProperty(source, start, end, property);
  return result.value;
}

function readDirectProperty(
  source: string,
  start: number,
  end: number,
  property: string
): { found: boolean; value?: string } {
  let index = start + 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  while (index < end) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    const character = source[index];
    if (isQuote(character)) {
      index = readQuotedString(source, index)?.next ?? end;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      braceDepth -= 1;
      index += 1;
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (character === "]") {
      bracketDepth -= 1;
      index += 1;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      parenDepth -= 1;
      index += 1;
      continue;
    }
    if (braceDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0) {
      index += 1;
      continue;
    }
    if (!isIdentifierStart(character)) {
      index += 1;
      continue;
    }
    const keyStart = index;
    index += 1;
    while (index < end && isIdentifierPart(source[index])) index += 1;
    const key = source.slice(keyStart, index);
    const colon = skipWhitespaceAndComments(source, index, end);
    if (source[colon] !== ":") {
      index = colon + 1;
      continue;
    }
    const valueStart = skipWhitespaceAndComments(source, colon + 1, end);
    const quoted = readQuotedString(source, valueStart);
    if (key === property) {
      return quoted ? { found: true, value: quoted.value.trim() } : { found: true };
    }
    index = skipPropertyValue(source, valueStart, end);
  }
  return { found: false };
}

function skipPropertyValue(source: string, start: number, end: number): number {
  let index = start;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  while (index < end) {
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    const character = source[index];
    if (isQuote(character)) {
      index = readQuotedString(source, index)?.next ?? end;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "," && braces === 0 && brackets === 0 && parentheses === 0) {
      return index + 1;
    }
    index += 1;
  }
  return end;
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_$]/u.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value);
}

function isQuote(value: string | undefined): value is "'" | '"' | "`" {
  return value === "'" || value === '"' || value === "`";
}

function readQuotedString(
  source: string,
  start: number
): { value: string; next: number } | undefined {
  const quote = source[start];
  if (!isQuote(quote)) return undefined;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) return { value, next: source.length };
      value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
      index += 1;
      continue;
    }
    if (character === quote) {
      return { value, next: index + 1 };
    }
    value += character;
  }
  return { value, next: source.length };
}

function skipWhitespaceAndComments(source: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    if (/\s/u.test(source[index]!)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start + 2);
  return end >= 0 ? end + 1 : source.length;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end >= 0 ? end + 2 : source.length;
}

function assertBpmNameLengths(definition: BpmProjectDefinition): void {
  assertBpmNameLength("业务模块", definition.businessModule.name);
  for (const flow of definition.flows) {
    assertBpmNameLength("流程", flow.name);
    assertBpmNameLength("业务实体", flow.entity.name);
    for (const page of flow.pages) {
      assertBpmNameLength("页面", page.name);
    }
    for (const item of flow.interfaces) {
      assertBpmNameLength("接口", item.name);
    }
  }
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

async function readRouteSources(projectPath: string): Promise<RouteSource[]> {
  const paths = await collectRouteFiles(projectPath);
  return Promise.all(paths.map(async (path) => ({
    path,
    source: await readFile(path, "utf8")
  })));
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

async function collectRouteFiles(
  directory: string,
  inRouteDirectory = false
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if ([".git", "build", "dist", "node_modules", "target", ".next", ".nuxt", "coverage"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const routeDirectory = inRouteDirectory || ROUTE_DIRECTORY_NAMES.has(entry.name.toLowerCase());
      result.push(...await collectRouteFiles(path, routeDirectory));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (!ROUTE_EXTENSIONS.has(extension)) continue;
    const stem = basename(entry.name, extension).toLowerCase();
    if (inRouteDirectory || ROUTE_FILE_PATTERN.test(stem)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
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
