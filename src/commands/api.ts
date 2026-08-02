import { Ajv, type ErrorObject } from "ajv";
import { Command } from "commander";
import type { EndpointDefinition } from "../catalog/schema.js";
import { CliError } from "../errors.js";
import { findEndpoint, loadCatalog } from "../catalog/loader.js";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { sendRequest, buildUrl } from "../http/client.js";
import { parsePairs, printValue, readJsonInput } from "../io.js";
import { assertPathTenantScope } from "../tenant.js";

export function registerApiCommands(program: Command, store: ConfigStore): void {
  const api = program.command("api").description("浏览和调用接口目录");

  api
    .command("domains")
    .description("列出接口业务领域")
    .action(async () => {
      const endpoints = await loadCatalog();
      const domains = [...new Set(endpoints.map((endpoint) => endpoint.domain))];
      printValue(domains);
    });

  api
    .command("list")
    .option("--domain <name>", "按业务领域筛选")
    .description("列出接口")
    .action(async (options: { domain?: string }) => {
      const endpoints = await loadCatalog();
      printValue(
        endpoints
          .filter((endpoint) => !options.domain || endpoint.domain === options.domain)
          .map(({ id, name, domain, title, description, method, path, permission, risk, callable, resourceExamples }) => ({
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
          }))
      );
    });

  api
    .command("describe")
    .argument("<id>", "接口 ID")
    .description("显示接口参数、风险和示例")
    .action(async (id: string) => {
      printValue(await findEndpoint(id));
    });

  api
    .command("call")
    .argument("<id>", "接口 ID")
    .option("--env <name>", "环境名称")
    .option("--body <file>", "JSON 请求体文件")
    .option("--data <json>", "内联 JSON 请求体")
    .option(
      "-q, --query <name=value>",
      "查询参数，可重复；例如 -q appModuleId=BASIC",
      collectOption,
      []
    )
    .option("--timeout <ms>", "超时时间", "30000")
    .option("--yes", "确认执行高风险接口")
    .option("--dry-run", "校验并显示脱敏请求，不发送")
    .description("按接口定义校验并发起请求")
    .action(
      async (
        id: string,
        options: {
          env?: string;
          body?: string;
          data?: string;
          query: string[];
          timeout: string;
          yes?: boolean;
          dryRun?: boolean;
        }
      ) => {
        const endpoint = await findEndpoint(id);
        if (!endpoint.callable || endpoint.method === "ANY") {
          throw new CliError(
            `接口 ${id} 是动态请求模板，不能直接调用；请使用对应业务命令，或使用 request 命令填写完整路径`
          );
        }
        const query = parsePairs(options.query, "=");
        validateQuery(endpoint.queryParameters, query);
        const body = await readJsonInput({ bodyFile: options.body, data: options.data });
        validateBody(endpoint.requestSchema, body);

        if (endpoint.risk === "high" && !options.yes && !options.dryRun) {
          throw new CliError("该接口属于高风险操作，请先使用 --dry-run 检查，确认后添加 --yes");
        }

        const config = await store.load();
        const environment = resolveEnvironment(config, options.env);
        assertPathTenantScope(
          environment.config.tenantCode,
          endpoint.path,
          environment.name
        );

        if (options.dryRun) {
          printValue({
            endpoint: endpoint.id,
            method: endpoint.method,
            url: buildUrl(environment.config.baseUrl, endpoint.path, query).toString(),
            environment: environment.name,
            headers: { "x-api-token": "***", "content-type": "application/json" },
            body
          });
          return;
        }

        const result = await sendRequest({
          baseUrl: environment.config.baseUrl,
          path: endpoint.path,
          method: endpoint.method,
          token: environment.token,
          query,
          body,
          timeoutMs: Number(options.timeout)
        });
        printValue(result.data);
      }
  );
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
