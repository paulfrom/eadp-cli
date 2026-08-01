import { Ajv, type ErrorObject } from "ajv";
import { Command } from "commander";
import { CliError } from "../errors.js";
import { findEndpoint, loadCatalog } from "../catalog/loader.js";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { sendRequest, buildUrl } from "../http/client.js";
import { printValue, readJsonInput } from "../io.js";

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
          .map(({ id, domain, title, method, path, permission, risk }) => ({
            id,
            domain,
            title,
            method,
            path,
            permission,
            risk
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
          timeout: string;
          yes?: boolean;
          dryRun?: boolean;
        }
      ) => {
        const endpoint = await findEndpoint(id);
        const body = await readJsonInput({ bodyFile: options.body, data: options.data });
        validateBody(endpoint.requestSchema, body);

        if (endpoint.risk === "high" && !options.yes && !options.dryRun) {
          throw new CliError("该接口属于高风险操作，请先使用 --dry-run 检查，确认后添加 --yes");
        }

        const config = await store.load();
        const environment = resolveEnvironment(config, options.env);

        if (options.dryRun) {
          printValue({
            endpoint: endpoint.id,
            method: endpoint.method,
            url: buildUrl(environment.config.baseUrl, endpoint.path).toString(),
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
          body,
          timeoutMs: Number(options.timeout)
        });
        printValue(result.data);
      }
    );
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
