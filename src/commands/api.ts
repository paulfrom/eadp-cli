import { Ajv, type ErrorObject } from "ajv";
import { Option, type Command } from "commander";
import type { EndpointDefinition } from "../catalog/schema.js";
import { CliError } from "../errors.js";
import { findEndpoint, loadCatalog } from "../catalog/loader.js";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { sendRequest, buildUrl } from "../http/client.js";
import { flattenPairs, parsePairs, printValue, readJsonInput } from "../io.js";
import { getRuntimeOptions } from "../runtime-options.js";
import { assertPathTenantScope } from "../tenant.js";
import type { VerbCommands } from "./verbs.js";

interface InspectApiOptions {
  domain?: string;
  domains?: boolean;
}

interface CallOptions {
  env?: string;
  body?: string;
  data?: string;
  query: string[];
  header: string[];
  yes?: boolean;
  dryRun?: boolean;
}

export function registerApiCommands(
  commands: Pick<VerbCommands, "inspect" | "call">,
  store: ConfigStore,
  root: Command
): void {
  commands.inspect
    .command("api")
    .description("查看接口目录；指定 ID 时显示参数、风险和示例")
    .argument("[id]", "接口 ID")
    .option("--domain <name>", "按业务领域筛选")
    .option("--domains", "仅列出业务领域")
    .action(async (id: string | undefined, options: InspectApiOptions) => {
      if (options.domains) {
        if (id || options.domain) {
          throw new CliError("--domains 不能与接口 ID 或 --domain 同时使用");
        }
        const endpoints = await loadCatalog();
        printValue(
          [...new Set(endpoints.map((endpoint) => endpoint.domain))],
          getRuntimeOptions(root).compact
        );
        return;
      }

      if (id) {
        printValue(await findEndpoint(id), getRuntimeOptions(root).compact);
        return;
      }

      const endpoints = await loadCatalog();
      printValue(
        endpoints
          .filter((endpoint) => !options.domain || endpoint.domain === options.domain)
          .map(toApiSummary),
        getRuntimeOptions(root).compact
      );
    });

  commands.call
    .argument("<id-or-method>", "接口 ID，或原始 HTTP 方法")
    .argument("[path]", "原始请求的接口路径")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--body <file>", "JSON 请求体文件")
    .option("--data <json>", "内联 JSON 请求体")
    .addOption(
      new Option("-q, --query <name=value>", "查询参数，可重复")
        .default([])
        .argParser(collectOption)
    )
    .addOption(
      new Option("-H, --header <name:value>", "额外请求头，仅原始请求可用")
        .default([])
        .argParser(collectOption)
    )
    .option("--yes", "确认执行已登记的高风险接口")
    .option("--dry-run", "校验并显示脱敏请求，不发送")
    .addHelpText(
      "after",
      `
示例：
  eadp call permission-role-menu-feature-tree --query featureRoleId=<角色 ID> --dry-run
  eadp call POST /api-gateway/sei-basic/example/save --data '{"name":"示例"}' --dry-run

通用 call 与高层命令使用同一路径租户校验：应用模块 CLI 资源名 app-module 对应后端路径 appModule，
功能项组 feature-group 对应 featureGroup，给号 serial-number 对应 serialNumberConfig；菜单（menu）和功能项（feature）
也只有 tenantCode === "global" 的环境才可远端操作。上述真实后端路径同样受 global 租户校验。`
    )
    .action(async (idOrMethod: string, path: string | undefined, options: CallOptions) => {
      if (path) {
        await callRaw(store, root, idOrMethod, path, options);
        return;
      }
      await callCatalog(store, root, idOrMethod, options);
    });
}

async function callCatalog(
  store: ConfigStore,
  root: Command,
  id: string,
  options: CallOptions
): Promise<void> {
  if (options.header.length > 0) {
    throw new CliError("已登记接口不支持 --header；如需原始请求请提供 HTTP 方法和路径");
  }
  const endpoint = await findEndpoint(id);
  if (!endpoint.callable || endpoint.method === "ANY") {
    throw new CliError(
      `接口 ${id} 是动态请求模板，不能直接调用；请使用对应业务命令，或使用 call <方法> <路径>`
    );
  }
  const query = parsePairs(options.query, "=");
  validateQuery(endpoint.queryParameters, query);
  const environment = resolveEnvironment(await store.load(), options.env);
  assertPathTenantScope(environment.config.tenantCode, endpoint.path, environment.name);
  const inputBody = await readJsonInput({ bodyFile: options.body, data: options.data });
  const body = bindEnvironmentTenantCode(
    endpoint.path,
    inputBody,
    environment.config.tenantCode
  );
  validateBody(endpoint.requestSchema, body);

  if (endpoint.risk === "high" && !options.yes && !options.dryRun) {
    throw new CliError("该接口属于高风险操作，请先使用 --dry-run 检查，确认后添加 --yes");
  }
  const runtime = getRuntimeOptions(root);

  if (options.dryRun) {
    printValue(
      {
        endpoint: endpoint.id,
        method: endpoint.method,
        url: buildUrl(environment.config.baseUrl, endpoint.path, query).toString(),
        environment: environment.name,
        headers: {
          ...redactedAuthHeaders(environment.authorization),
          "content-type": "application/json"
        },
        body
      },
      runtime.compact
    );
    return;
  }

  const result = await sendRequest({
    baseUrl: environment.config.baseUrl,
    path: endpoint.path,
    method: endpoint.method,
    token: environment.token,
    authorization: environment.authorization,
    query,
    body,
    timeoutMs: runtime.timeoutMs
  });
  printValue(result.data, runtime.compact);
}

async function callRaw(
  store: ConfigStore,
  root: Command,
  method: string,
  path: string,
  options: CallOptions
): Promise<void> {
  const environment = resolveEnvironment(await store.load(), options.env);
  assertPathTenantScope(environment.config.tenantCode, path, environment.name);
  const inputBody = await readJsonInput({ bodyFile: options.body, data: options.data });
  const body = bindEnvironmentTenantCode(
    path,
    inputBody,
    environment.config.tenantCode
  );
  const query = parsePairs(options.query, "=");
  const headers = flattenPairs(parsePairs(options.header, ":"));
  const runtime = getRuntimeOptions(root);

  if (options.dryRun) {
    printValue(
      {
        method: method.toUpperCase(),
        url: buildUrl(environment.config.baseUrl, path, query).toString(),
        environment: environment.name,
        headers: redactedAuthHeaders(environment.authorization, headers),
        body
      },
      runtime.compact
    );
    return;
  }

  const result = await sendRequest({
    baseUrl: environment.config.baseUrl,
    path,
    method,
    token: environment.token,
    authorization: environment.authorization,
    headers,
    query,
    body,
    timeoutMs: runtime.timeoutMs
  });
  printValue(result.data, runtime.compact);
}

function bindEnvironmentTenantCode(
  path: string,
  body: unknown,
  tenantCode: string | undefined
): unknown {
  if (!/\/serialNumberConfig\/save$/i.test(path)) {
    return body;
  }
  if (!tenantCode) {
    throw new CliError("当前环境未记录 tenantCode，请重新执行 env add");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CliError("给号配置保存请求体必须是 JSON 对象");
  }
  return { ...(body as Record<string, unknown>), tenantCode };
}

function redactedAuthHeaders(
  authorization: string | undefined,
  headers: Record<string, string> = {}
): Record<string, string> {
  const redacted = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !["authorization", "x-api-token"].includes(name.toLocaleLowerCase())
    )
  );
  if (authorization) {
    redacted.Authorization = "***";
  } else {
    redacted["x-api-token"] = "***";
  }
  return redacted;
}

function toApiSummary(endpoint: EndpointDefinition): Record<string, unknown> {
  const { id, name, domain, title, description, method, path, permission, risk, callable, resourceExamples } = endpoint;
  return {
    id,
    name: name ?? title,
    domain,
    title,
    description,
    method,
    path,
    permission,
    risk,
    callable,
    ...(resourceExamples.length === 0 ? {} : { resourceExamples })
  };
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function validateQuery(
  parameters: EndpointDefinition["queryParameters"],
  query: Record<string, string[]>
): void {
  const missing = parameters
    .filter((parameter) => parameter.required && !(parameter.name in query))
    .map((parameter) => parameter.name);
  if (missing.length > 0) {
    throw new CliError(`缺少查询参数：${missing.join("、")}`);
  }
}

function validateBody(schema: Record<string, unknown> | undefined, body: unknown): void {
  if (!schema) {
    return;
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(body)) {
    const messages = validate.errors
      ?.map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message}`)
      .join("；");
    throw new CliError(`请求参数校验失败：${messages}`);
  }
}
