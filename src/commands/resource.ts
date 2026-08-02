import { Command, Option } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import {
  ResourceClient,
  type ResourceFilter,
  type ResourceRecord
} from "../resource/client.js";
import { getResourceSpec, listResourceSpecs, type ResourceSpec } from "../resource/specs.js";
import { assertPathTenantScope } from "../tenant.js";

interface QueryOptions {
  env?: string;
  service: string;
  createdIn?: string;
  from?: string;
  to?: string;
  timeField: string;
  filter: string[];
  quick?: string;
  timeout: string;
  json?: boolean;
  compact?: boolean;
}

interface SyncOptions {
  source: string;
  target: string;
  createdIn?: string;
  from?: string;
  to?: string;
  timeField: string;
  timeout: string;
  apply?: boolean;
  json?: boolean;
  compact?: boolean;
}

export function registerResourceCommands(program: Command, store: ConfigStore): void {
  const resource = program
    .command("resource")
    .description("按时间和过滤条件查询资源，并在环境间预览或同步注册资源")
    .addHelpText(
      "after",
      `
查询支持任意具有 findByPage 接口的资源；同步需要注册字段与依赖映射。
当前可同步资源：${listResourceSpecs().join(", ")}

安全规则：sync 默认只输出差异；只有提供 --apply 才会写入目标环境。`
    );

  resource
    .command("query")
    .description("查询一个环境中的资源")
    .argument("<resource>", "资源接口名，例如 feature、dataRole")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--service <name>", "网关服务名", "sei-basic")
    .option("--created-in <yyyy-mm>", "按创建月份查询")
    .option("--from <datetime>", "起始时间，包含")
    .option("--to <datetime>", "结束时间，不包含")
    .option("--time-field <name>", "时间字段", "createdDate")
    .addOption(
      new Option("--filter <field:operator:value>", "附加过滤条件，可重复")
        .default([])
        .argParser(collect)
    )
    .option("--quick <text>", "快速查询文本")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp resource query feature --env dev --created-in 2026-07 --json
  eadp resource query feature --env dev \\
    --filter appModuleCode:EQ:BASIC --filter canMenu:EQ:true --json`
    )
    .action(async (resourceName: string, options: QueryOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertPathTenantScope(
        resolved.config.tenantCode,
        `/api-gateway/${options.service}/${resourceName}`,
        resolved.name
      );
      const filters = buildFilters(options);
      const client = createClient(resolved, options.service, options.timeout);
      const result = await client.findByPage(resourceName, {
        filters,
        ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
      });
      printValue(
        {
          kind: "eadp.resource.query.v1",
          environment: resolved.name,
          service: options.service,
          resource: resourceName,
          filters,
          total: result.total,
          items: result.rows
        },
        options.compact
      );
    });

  registerSyncLike(resource, store, "diff", false);
  registerSyncLike(resource, store, "sync", true);
}

function registerSyncLike(
  resource: Command,
  store: ConfigStore,
  commandName: "diff" | "sync",
  allowApply: boolean
): void {
  const command = resource
    .command(commandName)
    .description(
      commandName === "diff"
        ? "比较源环境与目标环境中的注册资源"
        : "预览或执行注册资源的跨环境同步"
    )
    .argument("<resource>", "注册资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称")
    .option("--created-in <yyyy-mm>", "只处理该创建月份的源资源")
    .option("--from <datetime>", "源资源起始时间，包含")
    .option("--to <datetime>", "源资源结束时间，不包含")
    .option("--time-field <name>", "时间字段", "createdDate")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON");
  if (allowApply) {
    command.option("--apply", "执行目标环境写入；默认只预览");
  }
  command
    .addHelpText(
      "after",
      `
示例：
  eadp resource ${commandName} feature --source dev --target test \\
    --created-in 2026-07 --json${
      allowApply
        ? `
  eadp resource sync feature --source dev --target test \\
    --created-in 2026-07 --apply --json`
        : ""
    }`
    )
    .action(async (resourceName: string, options: SyncOptions) => {
      await executeSync(store, resourceName, {
        ...options,
        apply: allowApply && options.apply === true
      });
    });
}

async function executeSync(
  store: ConfigStore,
  resourceName: string,
  options: SyncOptions
): Promise<void> {
  if (options.source === options.target) {
    throw new CliError("源环境和目标环境不能相同");
  }
  const spec = getResourceSpec(resourceName);
  const config = await store.load();
  const source = resolveEnvironment(config, options.source);
  const target = resolveEnvironment(config, options.target);
  assertMigrationTenantScope(source, target, spec);
  const sourceClient = createClient(source, spec.service, options.timeout);
  const targetClient = createClient(target, spec.service, options.timeout);
  const filters = buildFilters({
    ...(options.createdIn === undefined
      ? {}
      : { createdIn: options.createdIn }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    timeField: options.timeField,
    filter: []
  });
  const [sourcePage, targetPage] = await Promise.all([
    sourceClient.findByPage(spec.endpoint, { filters }),
    targetClient.findByPage(spec.endpoint)
  ]);
  const changes = [];
  for (const sourceRecord of sourcePage.rows) {
    const desired = await spec.toDesired(sourceRecord, targetClient);
    const key = identityValue(sourceRecord, spec);
    const targetRecord = findByIdentity(targetPage.rows, spec, key);
    if (targetRecord && typeof targetRecord.id === "string") {
      desired.id = targetRecord.id;
    }
    const changedFields = diffFields(targetRecord, desired, spec.writableFields);
    changes.push({
      key,
      action:
        targetRecord === undefined
          ? "create"
          : changedFields.length === 0
            ? "unchanged"
            : "update",
      changedFields,
      before: targetRecord ?? null,
      desired
    });
  }

  const writable = changes.filter((change) => change.action !== "unchanged");
  if (options.apply) {
    for (const change of writable) {
      await targetClient.save(spec.endpoint, change.desired);
    }
  }

  let verified = !options.apply;
  if (options.apply) {
    const after = await targetClient.findByPage(spec.endpoint);
    verified = changes.every((change) => {
      const targetRecord = findByIdentity(after.rows, spec, change.key);
      return (
        targetRecord !== undefined &&
        diffFields(targetRecord, change.desired, spec.writableFields).length === 0
      );
    });
    if (!verified) {
      throw new CliError("资源同步写入后回查失败");
    }
  }

  printValue(
    {
      kind: "eadp.resource.sync.v1",
      resource: resourceName,
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      filters,
      applied: options.apply === true && writable.length > 0,
      summary: {
        create: changes.filter((change) => change.action === "create").length,
        update: changes.filter((change) => change.action === "update").length,
        unchanged: changes.filter((change) => change.action === "unchanged").length
      },
      changes,
      verified
    },
    options.compact
  );
}

function assertMigrationTenantScope(
  source: ReturnType<typeof resolveEnvironment>,
  target: ReturnType<typeof resolveEnvironment>,
  spec: ResourceSpec
): void {
  const resourcePath = `/api-gateway/${spec.service}/${spec.endpoint}`;
  assertPathTenantScope(source.config.tenantCode, resourcePath, source.name);
  assertPathTenantScope(target.config.tenantCode, resourcePath, target.name);
}

function createClient(
  environment: ReturnType<typeof resolveEnvironment>,
  service: string,
  timeout: string
): ResourceClient {
  return new ResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    service,
    timeoutMs: parseTimeout(timeout)
  });
}

function buildFilters(
  options: Pick<
    QueryOptions,
    "createdIn" | "from" | "to" | "timeField" | "filter"
  >
): ResourceFilter[] {
  if (options.createdIn && (options.from || options.to)) {
    throw new CliError("--created-in 不能与 --from 或 --to 同时使用");
  }
  const filters = options.filter.map(parseFilter);
  if (options.createdIn) {
    const range = monthRange(options.createdIn);
    filters.push(
      { fieldName: options.timeField, operator: "GE", value: range.from },
      { fieldName: options.timeField, operator: "LT", value: range.to }
    );
  } else {
    if (options.from) {
      filters.push({
        fieldName: options.timeField,
        operator: "GE",
        value: options.from
      });
    }
    if (options.to) {
      filters.push({
        fieldName: options.timeField,
        operator: "LT",
        value: options.to
      });
    }
  }
  return filters;
}

function parseFilter(source: string): ResourceFilter {
  const first = source.indexOf(":");
  const second = source.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) {
    throw new CliError(`过滤条件格式无效：${source}`);
  }
  return {
    fieldName: source.slice(0, first),
    operator: source.slice(first + 1, second).toUpperCase(),
    value: parseScalar(source.slice(second + 1))
  };
}

function parseScalar(source: string): unknown {
  if (source === "true") return true;
  if (source === "false") return false;
  if (source === "null") return null;
  const numberValue = Number(source);
  return source.trim() !== "" && Number.isFinite(numberValue)
    ? numberValue
    : source;
}

function monthRange(source: string): { from: string; to: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(source);
  if (!match) {
    throw new CliError(`月份格式无效：${source}，应为 YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01 00:00:00`,
    to: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01 00:00:00`
  };
}

function identityValue(record: ResourceRecord, spec: ResourceSpec): string {
  const value = record[spec.identityField];
  if (typeof value !== "string" || !value) {
    throw new CliError(`源资源缺少业务唯一键 ${spec.identityField}`);
  }
  return value;
}

function findByIdentity(
  records: ResourceRecord[],
  spec: ResourceSpec,
  value: string
): ResourceRecord | undefined {
  const normalized = value.toLocaleLowerCase();
  const matches = records.filter((record) => {
    const candidate = record[spec.identityField];
    return (
      typeof candidate === "string" &&
      candidate.toLocaleLowerCase() === normalized
    );
  });
  if (matches.length > 1) {
    throw new CliError(`目标环境业务唯一键重复：${spec.identityField}=${value}`);
  }
  return matches[0];
}

function diffFields(
  before: ResourceRecord | undefined,
  desired: ResourceRecord,
  fields: string[]
): string[] {
  if (!before) {
    return fields.filter((field) => field in desired);
  }
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(desired[field])
  );
}

function parseTimeout(source: string): number {
  const timeoutMs = Number(source);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`超时时间无效：${source}`);
  }
  return timeoutMs;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
