import { Command, Option } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { sendRequest, buildUrl } from "../http/client.js";
import { flattenPairs, parsePairs, printValue, readJsonInput } from "../io.js";
import { assertPathTenantScope } from "../tenant.js";

interface RequestCommandOptions {
  env?: string;
  body?: string;
  data?: string;
  query: string[];
  header: string[];
  timeout: string;
  dryRun?: boolean;
  compact?: boolean;
}

export function registerRequestCommand(program: Command, store: ConfigStore): void {
  program
    .command("request")
    .argument("<method>", "HTTP 方法")
    .argument("<path>", "接口路径")
    .option("--env <name>", "环境名称")
    .option("--body <file>", "JSON 请求体文件", undefined)
    .option("--data <json>", "内联 JSON 请求体")
    .addOption(new Option("-q, --query <name=value>", "Query 参数").default([]).argParser(collect))
    .addOption(new Option("-H, --header <name:value>", "额外请求头").default([]).argParser(collect))
    .option("--timeout <ms>", "超时时间", "30000")
    .option("--dry-run", "只显示脱敏请求，不发送")
    .option("--compact", "输出单行 JSON")
    .description("向任意 EADP 接口发送请求")
    .action(async (method: string, path: string, options: RequestCommandOptions) => {
      const config = await store.load();
      const environment = resolveEnvironment(config, options.env);
      assertPathTenantScope(environment.config.tenantCode, path, environment.name);
      const body = await readJsonInput({ bodyFile: options.body, data: options.data });
      const query = parsePairs(options.query, "=");
      const headers = flattenPairs(parsePairs(options.header, ":"));
      const timeoutMs = Number(options.timeout);

      if (options.dryRun) {
        printValue({
          method: method.toUpperCase(),
          url: buildUrl(environment.config.baseUrl, path, query).toString(),
          environment: environment.name,
          headers: { ...headers, "x-api-token": "***" },
          body
        });
        return;
      }

      const result = await sendRequest({
        baseUrl: environment.config.baseUrl,
        path,
        method,
        token: environment.token,
        headers,
        query,
        body,
        timeoutMs
      });
      printValue(result.data, options.compact);
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
