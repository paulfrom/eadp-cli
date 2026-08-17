import { Option, type Command } from "commander";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError, errorMessage, type CliErrorCode } from "../errors.js";
import { getRuntimeOptions, type RuntimeOptions } from "../runtime-options.js";
import { formatCompactNdjson, printValue, readJsonInput } from "../io.js";
import { cliVersion } from "../version.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import { ResourceClient, createResourceClient, type ResourceFilter, type ResourceRecord } from "../resource/core/client.js";
import {
  getResourceContract,
  listResourceContracts,
  resourceAdapterRegistry,
  resourcePhaseHooksRegistry,
  specialResourceHandlerRegistry,
  resourceRegistry
} from "../resource/catalog.js";
import type {
  ResourceContract,
  ResourceSelectorContract
} from "../resource/core/contracts.js";
import {
  ResourceEngine,
  assertMigrationTenants,
  assertResourceTenant
} from "../resource/core/engine.js";
import type {
  SpecialResourceHandler
} from "../resource/handlers/contracts.js";

interface FilterOptions {
  filter: string[];
  quick?: string;
  createdIn?: string;
  from?: string;
  to?: string;
  timeField?: string;
}
type ResourceAction = "query" | "write" | "compare" | "sync";
const RESOURCE_ACTIONS: readonly ResourceAction[] = ["query", "write", "compare", "sync"];
interface ResourceEnvironmentOptions { env?: string; }
interface ResourceWriteOptions extends ResourceEnvironmentOptions { data?: string; apply?: boolean; }
interface ResourceQueryOptions extends FilterOptions, ResourceEnvironmentOptions {
  count?: boolean;
  summary?: boolean;
  limit?: string;
  fields?: string;
}
interface ResourceMigrationOptions extends FilterOptions {
  source: string;
  target: string;
  apply?: boolean;
  select?: string[];
}
const engine = new ResourceEngine(resourceAdapterRegistry, resourcePhaseHooksRegistry, resourceRegistry);

/** Register the generic resource-first command tree. */
export function registerResourceCommands(
  store: ConfigStore,
  root: Command
): void {
  const registeredContracts = listResourceContracts();
  const ordinaryResources = registeredContracts
    .filter((contract) => !contract.handler)
    .map((contract) => formatResourceName(contract))
    .sort()
    .join("、") || "无";
  const behaviorExtensions = registeredContracts
    .filter((contract) => contract.handler)
    .map((contract) => contract.id)
    .sort()
    .join("、") || "无";
  const resource = root
    .command("resource")
    .description("按声明式资源契约查询、写入、比较和迁移（默认预览；删除仅按显式契约执行）")
    .addHelpText(
      "after",
      `
资源均由契约注册；普通资源由 API 与业务语义声明获得统一动作，特殊资源可为同一动作登记行为扩展。
动作统一为 create、update、delete、unchanged、blocked；delete 只来自资源声明的完整删除契约；传输失败立即停止，不自动重试。
参数完整时直接执行；资源名、环境或选择器不明确时用 inspect 发现。
使用 eadp resource inspect [name] [action] 发现资源能力、契约摘要或单个动作的结构化参数。
示例：
  eadp resource inspect
  eadp resource inspect feature
  eadp resource inspect menu compare
  eadp resource query feature --env dev --count
  eadp resource query feature --env dev --fields code,name --limit 20
  eadp resource write app-module --env global-dev --data '{"code":"ORDER","name":"订单"}' --apply
  eadp resource compare feature --source dev --target test
  eadp resource sync menu --source dev --target test --select code=PURCHASE --apply`
    );

  resource
    .command("inspect")
    .description("发现资源：无参数列出资源及能力；<name> 输出契约摘要；<name> <action> 输出该动作的结构化参数")
    .argument("[name]", "资源名")
    .argument("[action]", "动作：query、write、compare 或 sync")
    .action(async (name: string | undefined, action: string | undefined) => {
      const runtime = getRuntimeOptions(root);
      const environment = await readEnvironmentOverview(store);
      if (name === undefined) {
        printValue(
          {
            kind: "eadp.resource.catalog.v2",
            cliVersion,
            environment,
            resources: listResourceContracts().map((contract) => catalogEntry(contract))
          },
          runtime.compact
        );
        return;
      }
      const contract = getResourceContract(name);
      if (action === undefined) {
        printValue(
          {
            kind: "eadp.resource.contract.v1",
            cliVersion,
            environment,
            ...contractSummary(contract)
          },
          runtime.compact
        );
        return;
      }
      if (!RESOURCE_ACTIONS.includes(action as ResourceAction)) {
        throw new CliError(
          `不支持的动作：${action}，应为 query、write、compare 或 sync`,
          1,
          { code: "INVALID_ACTION", candidates: RESOURCE_ACTIONS, requiredInput: "action" }
        );
      }
      if (!contract.capabilities.includes(action as ResourceAction)) {
        throw new CliError(
          `资源 ${contract.id} 未声明 ${action} 能力`,
          1,
          { code: "CAPABILITY_MISSING", candidates: contract.capabilities, requiredInput: "action" }
        );
      }
      printValue(
        {
          kind: "eadp.resource.action-schema.v1",
          cliVersion,
          resource: contract.id,
          action,
          environment,
          tenant: contract.tenant,
          requiredOptions: actionRequiredOptions(action as ResourceAction),
          optionalOptions: actionOptionalOptions(action as ResourceAction, contract),
          selectors: selectorDigest(contract),
          fields: actionFields(action as ResourceAction, contract)
        },
        runtime.compact
      );
    });

  addResourceFilterOptions(resource
    .command("query")
    .description("按资源契约查询（分页自动聚合；--count/--summary 只读第一页）")
    .argument("<name>", "资源名")
    .option("--env <env>", "环境名称；默认使用当前环境")
    .option("--count", "只输出记录总数，不输出明细")
    .option("--summary", "输出记录总数与 summaryInfo，不输出明细")
    .option("--limit <n>", "最多返回的记录条数")
    .option("--fields <fields>", "只输出指定字段，逗号分隔"), true)
    .addHelpText("after", "\n支持 EQ、NE、LIKE、GT、GE、LT、LE；分页资源会在返回前完成全部页面读取。")
    .action(async (name: string, options: ResourceQueryOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "query");
      const environment = resolveEnvironment(await store.load(), options.env);
      assertResourceTenant(contract, environment.config.tenantCode, environment.name);
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      const special = getSpecialHandler(contract, "query");
      const countMode: "none" | "count" | "summary" = options.count
        ? "count"
        : options.summary
          ? "summary"
          : "none";

      if (countMode !== "none") {
        if (special?.query) {
          const result = await special.query({
            environment,
            runtime,
            filters,
            ...(options.quick === undefined ? {} : { quick: options.quick })
          });
          printValue(
            {
              kind: countMode === "count" ? "eadp.resource.count.v1" : "eadp.resource.summary.v1",
              resource: contract.id,
              environment: environment.name,
              count: result.items.length,
              ...(countMode === "summary" ? { summaryInfo: null } : {})
            },
            runtime.compact
          );
          return;
        }
        const client = createClient(environment, contract.service, runtime.timeoutMs);
        const counted = await client.countContract(contract, {
          filters,
          ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
        });
        printValue(
          {
            kind: countMode === "count" ? "eadp.resource.count.v1" : "eadp.resource.summary.v1",
            resource: contract.id,
            environment: environment.name,
            count: counted.count,
            ...(countMode === "summary" ? { summaryInfo: counted.summaryInfo } : {})
          },
          runtime.compact
        );
        return;
      }

      let result: ResourceQueryResult;
      if (special?.query) {
        result = await special.query({
          environment,
          runtime,
          filters,
          ...(options.quick === undefined ? {} : { quick: options.quick })
        });
      } else {
        const client = createClient(environment, contract.service, runtime.timeoutMs);
        result = await engine.query(contract, client, environment.name, {
          filters,
          ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
        });
      }
      const items = applyResultTrimming(result.items, options);
      printQuery({ ...result, items }, runtime);
    });

  resource
    .command("write")
    .description("新增或更新资源；默认只生成计划，--apply 才写入并回查；不执行目标独有删除")
    .argument("<name>", "资源名")
    .requiredOption("--env <env>", "目标环境名称")
    .requiredOption("--data <json>", "JSON 对象或对象数组")
    .option("--apply", "执行 create/update；默认预览")
    .action(async (name: string, options: ResourceWriteOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "write");
      const environment = resolveEnvironment(await store.load(), options.env);
      assertResourceTenant(contract, environment.config.tenantCode, environment.name);
      const input = await readJsonInput({ data: options.data });
      if (!isRecordOrArray(input)) throw new CliError("--data 必须是 JSON 对象或对象数组");
      const runtime = getRuntimeOptions(root);
      const apply = options.apply === true;
      const result = await executeResourceChangeAction({
        apply,
        operationStoreDirectory: store.directory,
        command: `eadp resource write ${contract.id}`,
        targetEnvironment: environment.name
      }, async (recorder) => {
        return engine.write(
          contract,
          createClient(environment, contract.service, runtime.timeoutMs),
          input,
          {
            apply,
            ...(environment.config.tenantCode === undefined
              ? {}
              : { targetTenantCode: environment.config.tenantCode }),
            ...(recorder ? { recorder } : {})
          }
        );
      });
      printValue({ ...result, environment: environment.name }, runtime.compact);
    });

  addResourceMigrationOptions(resource
    .command("compare")
    .description("只读比较两个环境，输出统一 change plan")
    .argument("<name>", "资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称"))
    .action(async (name: string, options: ResourceMigrationOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "compare");
      const { source, target } = await resolveMigrationEnvironments(store, options);
      assertMigrationTenants(contract, sourceForTenant(source), sourceForTenant(target));
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      if (contract.handler && filters.length > 0) {
        throw new CliError(`资源 ${contract.id} 不支持通用过滤条件`);
      }
      const selectors = parseSelectOptions(contract, options.select ?? []);
      const result = await engine.compare(
        contract,
        createClient(source, contract.service, runtime.timeoutMs),
        createClient(target, contract.service, runtime.timeoutMs),
        { source: source.name, target: target.name },
        {
          sourceQuery: { filters },
          ...(target.config.tenantCode === undefined ? {} : { targetTenantCode: target.config.tenantCode }),
          selectors
        }
      );
      printValue(result, runtime.compact);
    });

  addResourceMigrationOptions(resource
    .command("sync")
    .description("复用 compare change plan；默认预览，--apply 执行安全 create/update/delete 并回查")
    .argument("<name>", "资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称")
    .option("--apply", "执行同步；仅按显式删除契约执行 delete，blocked 记录会跳过"))
    .action(async (name: string, options: ResourceMigrationOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "sync");
      const { source, target } = await resolveMigrationEnvironments(store, options);
      assertMigrationTenants(contract, sourceForTenant(source), sourceForTenant(target));
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      if (contract.handler && filters.length > 0) {
        throw new CliError(`资源 ${contract.id} 不支持通用过滤条件`);
      }
      const selectors = parseSelectOptions(contract, options.select ?? []);
      const apply = options.apply === true;
      const result = await executeResourceChangeAction({
        apply,
        operationStoreDirectory: store.directory,
        command: `eadp resource sync ${contract.id}`,
        targetEnvironment: target.name
      }, async (recorder) => {
        return engine.sync(
          contract,
          createClient(source, contract.service, runtime.timeoutMs),
          createClient(target, contract.service, runtime.timeoutMs),
          { source: source.name, target: target.name },
          {
            apply,
            sourceQuery: { filters },
            ...(target.config.tenantCode === undefined ? {} : { targetTenantCode: target.config.tenantCode }),
            ...(recorder ? { recorder } : {}),
            selectors
          }
        );
      });
      printValue(result, runtime.compact);
    });
}

interface ResourceQueryResult {
  kind: string;
  resource: string;
  environment: string;
  total: number;
  items: ResourceRecord[];
}

async function readEnvironmentOverview(store: ConfigStore): Promise<{ current: string | null; names: string[] }> {
  const config = await store.load();
  return {
    current: config.currentEnvironment ?? null,
    names: Object.keys(config.environments ?? {})
  };
}

function catalogEntry(contract: ResourceContract): Record<string, unknown> {
  return {
    name: contract.id,
    aliases: contract.aliases ?? [],
    title: contract.title,
    description: contract.description,
    help: contract.help,
    capabilities: contract.capabilities,
    read: contract.read,
    query: contract.query,
    save: contract.save ?? null,
    rollback: contract.rollback ?? null,
    deletion: contract.deletion ?? null,
    identityFields: contract.identityFields,
    compareFields: contract.compareFields,
    writableFields: contract.writableFields,
    tenant: contract.tenant,
    filtering: contract.filtering ?? { time: false },
    enums: contract.enums ?? {},
    adapter: contract.adapter ?? null,
    handler: contract.handler ?? null,
    selectors: contract.selectors ?? []
  };
}

/** The digest a model needs to route: identity, capabilities, constraints. */
function contractSummary(contract: ResourceContract): Record<string, unknown> {
  return {
    id: contract.id,
    aliases: contract.aliases ?? [],
    title: contract.title,
    description: contract.description,
    help: contract.help,
    service: contract.service,
    capabilities: contract.capabilities,
    tenant: contract.tenant,
    identityFields: contract.identityFields,
    compareFields: contract.compareFields,
    writableFields: contract.writableFields,
    filtering: contract.filtering ?? { time: false },
    enums: contract.enums ?? {},
    selectors: contract.selectors ?? [],
    defaults: contract.defaults ?? {},
    rollback: contract.rollback ?? null,
    deletion: contract.deletion ?? null
  };
}

function selectorDigest(contract: ResourceContract): Record<string, { required: boolean; description?: string }> {
  return Object.fromEntries(
    (contract.selectors ?? []).map((selector) => [
      selector.name,
      {
        required: selector.required,
        ...(selector.description ? { description: selector.description } : {})
      }
    ])
  );
}

function actionRequiredOptions(action: ResourceAction): string[] {
  switch (action) {
    case "write":
      return ["--env <env>", "--data <json>"];
    case "compare":
    case "sync":
      return ["--source <env>", "--target <env>"];
    case "query":
      return [];
  }
}

function actionOptionalOptions(action: ResourceAction, contract: ResourceContract): string[] {
  const base: string[] = [];
  const selectors = (contract.selectors ?? []).length > 0
    ? ["--select <name=value>"]
    : [];
  const time = contract.filtering?.time === true
    ? ["--created-in <yyyy-mm>", "--from <datetime>", "--to <datetime>", "--time-field <field>"]
    : [];
  const filter = contract.handler ? [] : ["--filter <field:operator:value>"];
  switch (action) {
    case "query":
      return [
        "--env <env>",
        "--quick <text>",
        ...filter,
        ...time,
        "--count",
        "--summary",
        "--limit <n>",
        "--fields <a,b>"
      ];
    case "write":
      return ["--apply"];
    case "compare":
      return [...filter, ...time, ...selectors];
    case "sync":
      return [...filter, ...time, ...selectors, "--apply"];
  }
}

function actionFields(action: ResourceAction, contract: ResourceContract): Record<string, unknown> {
  switch (action) {
    case "query":
      return {
        filtering: contract.filtering ?? { time: false },
        enums: contract.enums ?? {}
      };
    case "write":
      return {
        identityFields: contract.identityFields,
        writableFields: contract.writableFields,
        enums: contract.enums ?? {},
        defaults: contract.defaults ?? {},
        rollback: contract.rollback ?? null
      };
    case "compare":
      return {
        identityFields: contract.identityFields,
        compareFields: contract.compareFields,
        enums: contract.enums ?? {},
        deletion: contract.deletion ?? null
      };
    case "sync":
      return {
        identityFields: contract.identityFields,
        compareFields: contract.compareFields,
        writableFields: contract.writableFields,
        enums: contract.enums ?? {},
        defaults: contract.defaults ?? {},
        rollback: contract.rollback ?? null,
        deletion: contract.deletion ?? null
      };
  }
}

function applyResultTrimming(
  items: ResourceRecord[],
  options: ResourceQueryOptions
): ResourceRecord[] {
  let result = items;
  if (options.fields) {
    const fields = options.fields.split(",").map((field) => field.trim()).filter(Boolean);
    if (fields.length === 0) {
      throw new CliError("--fields 不能为空");
    }
    result = result.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
  }
  if (options.limit !== undefined) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new CliError(`--limit 必须是非负整数：${options.limit}`);
    }
    result = result.slice(0, limit);
  }
  return result;
}

async function resolveMigrationEnvironments(
  store: ConfigStore,
  options: ResourceMigrationOptions
): Promise<{ source: ResolvedEnvironment; target: ResolvedEnvironment }> {
  if (options.source === options.target) throw new CliError("源环境和目标环境不能相同");
  const config = await store.load();
  return { source: resolveEnvironment(config, options.source), target: resolveEnvironment(config, options.target) };
}

function sourceForTenant(environment: ResolvedEnvironment): { name: string; tenantCode?: string } {
  return { name: environment.name, ...(environment.config.tenantCode === undefined ? {} : { tenantCode: environment.config.tenantCode }) };
}

function createClient(environment: ResolvedEnvironment, service: string, timeoutMs: number): ResourceClient {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service,
    timeoutMs
  });
}

function printQuery(result: ResourceQueryResult, runtime: RuntimeOptions): void {
  if (runtime.output === "compact-ndjson") {
    process.stdout.write(formatCompactNdjson(result.items, { meta: { ...result, items: undefined }, count: result.items.length }));
    return;
  }
  printValue(result, runtime.compact);
}

function addResourceFilterOptions(command: Command, quick: boolean): Command {
  command
    .addOption(
      new Option("--filter <field:operator:value>", "附加过滤条件，可重复")
        .default([])
        .argParser(collect)
    )
    .option("--created-in <yyyy-mm>", "按创建月份过滤")
    .option("--from <datetime>", "起始时间，包含")
    .option("--to <datetime>", "结束时间，不包含")
    .option("--time-field <field>", "覆盖契约声明的时间字段");
  if (quick) command.option("--quick <text>", "快速查询文本");
  return command;
}

function addResourceMigrationOptions(command: Command): Command {
  command
    .addOption(
      new Option("--select <name=value>", "资源选择器，可重复（如 code=PURCHASE）")
        .default([])
        .argParser(collect)
    );
  return addResourceFilterOptions(command, false);
}

function formatResourceName(contract: ResourceContract): string {
  return contract.aliases?.length
    ? `${contract.id}（别名：${contract.aliases.join("、")}）`
    : contract.id;
}

function buildResourceFilters(contract: ResourceContract, options: FilterOptions): ResourceFilter[] {
  const hasTimeFilter = Boolean(options.createdIn || options.from || options.to);
  if (hasTimeFilter && contract.filtering?.time !== true) {
    throw new CliError(`资源 ${contract.id} 不支持时间过滤`);
  }
  if (options.createdIn && (options.from || options.to)) {
    throw new CliError("--created-in 不能与 --from 或 --to 同时使用");
  }
  const filters = options.filter.map(parseFilter);
  const timeField = options.timeField ?? contract.filtering?.defaultTimeField;
  if (hasTimeFilter && !timeField) {
    throw new CliError(`资源 ${contract.id} 未声明默认时间字段，请提供 --time-field`);
  }
  if (options.createdIn) {
    const range = monthRange(options.createdIn);
    filters.push(
      { fieldName: timeField!, operator: "GE", value: range.from },
      { fieldName: timeField!, operator: "LT", value: range.to }
    );
  } else {
    if (options.from) filters.push({ fieldName: timeField!, operator: "GE", value: options.from });
    if (options.to) filters.push({ fieldName: timeField!, operator: "LT", value: options.to });
  }
  return filters;
}

function monthRange(source: string): { from: string; to: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(source);
  if (!match) throw new CliError(`月份格式无效：${source}，应为 YYYY-MM`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01 00:00:00`,
    to: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01 00:00:00`
  };
}

/**
 * Resolve `--select name=value` pairs against the current contract's declared
 * selectors only. Unknown names and missing required selectors fail fast, so
 * the option surface stays small and stable for every resource.
 */
function parseSelectOptions(
  contract: ResourceContract,
  values: string[]
): Readonly<Record<string, string>> {
  const declared = new Map<string, ResourceSelectorContract>(
    (contract.selectors ?? []).map((selector) => [selector.name, selector])
  );
  const resolved: Record<string, string> = {};
  for (const raw of values) {
    const index = raw.indexOf("=");
    if (index <= 0) {
      throw new CliError(`--select 格式无效：${raw}，应为 name=value`, 1, { code: "INVALID_ARGUMENT", requiredInput: "selector" });
    }
    const name = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    const selector = declared.get(name);
    if (!selector) {
      throw new CliError(
        `资源 ${contract.id} 未声明选择器：${name}`,
        1,
        {
          code: "UNKNOWN_SELECTOR",
          candidates: [...declared.keys()],
          requiredInput: "selector"
        }
      );
    }
    if (value === "") {
      throw new CliError(`资源 ${contract.id} 的 --select ${name} 值不能为空`, 1, { code: "INVALID_ARGUMENT", requiredInput: "selector" });
    }
    resolved[name] = value;
  }
  for (const selector of contract.selectors ?? []) {
    if (selector.required && resolved[selector.name] === undefined) {
      throw new CliError(
        `资源 ${contract.id} 必须提供 --select ${selector.name}=<${selector.valuePlaceholder}>`,
        1,
        { code: "REQUIRED_SELECTOR_MISSING", requiredInput: "selector" }
      );
    }
  }
  return Object.freeze(resolved);
}

function getSpecialHandler(
  contract: ResourceContract,
  capability: "query"
): SpecialResourceHandler | undefined {
  if (!contract.handler) return undefined;
  const handler = specialResourceHandlerRegistry.get(contract.handler);
  if (typeof handler[capability] !== "function") {
    throw new CliError(`资源 ${contract.id} 的 ${capability} 处理器未注册`);
  }
  return handler;
}

/** One operation lifecycle for ordinary resources and behavior extensions. */
async function executeResourceChangeAction<T extends object>(
  options: {
    apply: boolean;
    operationStoreDirectory: string;
    command: string;
    targetEnvironment: string;
  },
  action: (recorder: OperationRecorder | undefined) => Promise<T>
): Promise<T & { operationId?: string }> {
  const recorder = options.apply
    ? new OperationRecorder(
        new OperationLogStore(options.operationStoreDirectory),
        options.command,
        options.targetEnvironment
      )
    : undefined;
  try {
    const result = await action(recorder);
    const operationId = await recorder?.complete();
    return operationId ? { ...result, operationId } : result;
  } catch (error) {
    await recorder?.fail(error);
    throw operationError(error, recorder);
  }
}

function assertCapability(
  contract: ResourceContract,
  capability: "query" | "write" | "compare" | "sync"
): void {
  if (!contract.capabilities.includes(capability)) {
    throw new CliError(
      `资源 ${contract.id} 未声明 ${capability} 能力`,
      1,
      { code: "CAPABILITY_MISSING", candidates: contract.capabilities, requiredInput: "action" }
    );
  }
}

function operationError(error: unknown, recorder: OperationRecorder | undefined): CliError {
  const suffix = recorder?.hasActions
    ? `；可使用 operation-id ${recorder.operationId} 回滚已新增记录`
    : "";
  const code: CliErrorCode = error instanceof CliError ? error.code : "CLI_ERROR";
  return new CliError(`${errorMessage(error)}${suffix}`, 1, { code });
}

function parseFilter(source: string): ResourceFilter {
  const first = source.indexOf(":");
  const second = source.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) throw new CliError(`过滤条件格式无效：${source}`);
  const operator = source.slice(first + 1, second).toUpperCase();
  if (!["EQ", "NE", "LIKE", "GT", "GE", "LT", "LE"].includes(operator)) {
    throw new CliError(`不支持的过滤操作符：${operator}`);
  }
  return { fieldName: source.slice(0, first), operator, value: parseScalar(source.slice(second + 1)) };
}

function parseScalar(source: string): unknown {
  if (source === "true") return true;
  if (source === "false") return false;
  if (source === "null") return null;
  const numberValue = Number(source);
  return source.trim() !== "" && Number.isFinite(numberValue) ? numberValue : source;
}

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRecordOrArray(value: unknown): value is ResourceRecord | ResourceRecord[] {
  return isRecord(value) || (Array.isArray(value) && value.every(isRecord));
}
