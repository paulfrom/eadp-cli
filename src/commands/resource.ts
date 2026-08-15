import { Option, type Command } from "commander";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError, errorMessage } from "../errors.js";
import { getRuntimeOptions, type RuntimeOptions } from "../runtime-options.js";
import { formatCompactNdjson, printValue, readJsonInput } from "../io.js";
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
interface ResourceEnvironmentOptions { env?: string; }
interface ResourceWriteOptions extends ResourceEnvironmentOptions { data?: string; apply?: boolean; }
interface ResourceMigrationOptions extends FilterOptions {
  source: string;
  target: string;
  apply?: boolean;
  [key: string]: unknown;
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
    .map((contract) => contract.id)
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
契约包含查询/保存接口、分页策略、业务唯一键、可比较/可写字段、租户策略和能力开关。
已注册普通资源：${ordinaryResources}；行为扩展资源：${behaviorExtensions}。
动作统一为 create、update、delete、unchanged、blocked；delete 只来自资源声明的完整删除契约；传输失败立即停止，不自动重试。
使用 resource list/describe 发现每个资源的能力、选择器与领域说明。
示例：
  eadp resource list
  eadp resource describe feature
  eadp resource query feature --env dev
  eadp resource write app-module --env global-dev --data '{"code":"ORDER","name":"订单"}' --apply
  eadp resource compare feature --source dev --target test
  eadp resource sync feature --source dev --target test --apply`
    );

  resource
    .command("list")
    .description("列出已注册资源契约及其能力")
    .action(() => {
      printValue(
        {
          kind: "eadp.resource.catalog.v2",
          resources: listResourceContracts().map((contract) => ({
            name: contract.id,
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
          }))
        },
        getRuntimeOptions(root).compact
      );
    });

  resource
    .command("describe")
    .description("查看一个资源契约的完整查询/保存/迁移语义")
    .argument("<name>", "资源名")
    .action((name: string) => {
      const contract = getResourceContract(name);
      printValue({ kind: "eadp.resource.contract.v1", ...contract }, getRuntimeOptions(root).compact);
    });

  addResourceFilterOptions(resource
    .command("query")
    .description("按资源契约完整查询（分页自动聚合）")
    .argument("<name>", "资源名")
    .option("--env <env>", "环境名称；默认使用当前环境"), true)
    .addHelpText("after", "\n支持 EQ、NE、LIKE、GT、GE、LT、LE；分页资源会在返回前完成全部页面读取。")
    .action(async (name: string, options: FilterOptions & ResourceEnvironmentOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "query");
      const environment = resolveEnvironment(await store.load(), options.env);
      assertResourceTenant(contract, environment.config.tenantCode, environment.name);
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      const special = getSpecialHandler(contract, "query");
      if (special?.query) {
        const result = await special.query({
          environment,
          runtime,
          filters,
          ...(options.quick === undefined ? {} : { quick: options.quick })
        });
        printQuery(result, runtime);
        return;
      }
      const client = createClient(environment, contract.service, runtime.timeoutMs);
      const result = await engine.query(contract, client, environment.name, {
        filters,
        ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
      });
      printQuery(result, runtime);
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

  addResourceFilterOptions(
    addResourceSelectorOptions(resource
      .command("compare")
      .description("只读比较两个环境，输出统一 change plan")
      .argument("<name>", "资源名")
      .requiredOption("--source <env>", "源环境名称")
      .requiredOption("--target <env>", "目标环境名称")),
    false)
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
      const selectors = validateSelectorOptions(contract, options);
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

  addResourceFilterOptions(
    addResourceSelectorOptions(resource
      .command("sync")
      .description("复用 compare change plan；默认预览，--apply 执行安全 create/update/delete 并回查")
      .argument("<name>", "资源名")
      .requiredOption("--source <env>", "源环境名称")
      .requiredOption("--target <env>", "目标环境名称")
      .option("--apply", "执行同步；仅按显式删除契约执行 delete，blocked 记录会跳过")),
    false)
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
      const selectors = validateSelectorOptions(contract, options);
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

function printQuery(result: { items: ResourceRecord[]; kind: string; resource: string; environment: string; total: number }, runtime: RuntimeOptions): void {
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

function addResourceSelectorOptions(command: Command): Command {
  for (const selector of collectResourceSelectors()) {
    command.option(
      `--${selector.name} <${selector.valuePlaceholder}>`,
      `${selector.description}${selector.required ? "（必填）" : ""}`
    );
  }
  return command;
}

function collectResourceSelectors(): ResourceSelectorContract[] {
  const selectors = new Map<string, ResourceSelectorContract>();
  for (const contract of listResourceContracts()) {
    for (const selector of contract.selectors ?? []) {
      const existing = selectors.get(selector.name);
      if (existing && (
        existing.valuePlaceholder !== selector.valuePlaceholder ||
        existing.description !== selector.description
      )) {
        throw new CliError(`资源选择器声明冲突：--${selector.name}`);
      }
      selectors.set(selector.name, existing
        ? { ...existing, required: existing.required && selector.required }
        : selector);
    }
  }
  return [...selectors.values()].sort((left, right) => left.name.localeCompare(right.name));
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

function validateSelectorOptions(
  contract: ResourceContract,
  options: Record<string, unknown>
): Readonly<Record<string, string>> {
  const declared = new Map((contract.selectors ?? []).map((selector) => [selector.name, selector]));
  const values: Record<string, string> = {};
  for (const selector of collectResourceSelectors()) {
    const value = options[optionAttributeName(selector.name)];
    if (value === undefined) continue;
    if (!declared.has(selector.name)) {
      throw new CliError(`--${selector.name} 不适用于资源 ${contract.id}`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new CliError(`资源 ${contract.id} 的 --${selector.name} 值不能为空`);
    }
    values[selector.name] = value;
  }
  for (const selector of contract.selectors ?? []) {
    if (selector.required && values[selector.name] === undefined) {
      throw new CliError(`资源 ${contract.id} 必须提供 --${selector.name}`);
    }
  }
  return Object.freeze(values);
}

function optionAttributeName(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
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
    throw new CliError(`资源 ${contract.id} 未声明 ${capability} 能力`);
  }
}

function operationError(error: unknown, recorder: OperationRecorder | undefined): CliError {
  const suffix = recorder?.hasActions
    ? `；可使用 operation-id ${recorder.operationId} 回滚已新增记录`
    : "";
  return new CliError(`${errorMessage(error)}${suffix}`);
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
