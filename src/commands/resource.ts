import { Option, type Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { syncBpmFlow } from "../bpm/sync.js";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError, errorMessage } from "../errors.js";
import { getRuntimeOptions, type RuntimeOptions } from "../runtime-options.js";
import { formatCompactNdjson, printValue, readJsonInput } from "../io.js";
import {
  assertCanBeParent,
  loadMenus,
  logicalMenu,
  resolveFeatureId,
  selectMenuByCode,
  filterMenus,
  syncMenus,
  assertMenuCodeLength
} from "../menu/service.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import { ResourceClient, type ResourceFilter, type ResourceRecord } from "../resource/client.js";
import {
  getResourceContract,
  listResourceContracts,
  resourceAdapterRegistry
} from "../resource/catalog.js";
import type { ResourceContract } from "../resource/contracts.js";
import { ResourceEngine, assertMigrationTenants, assertResourceTenant } from "../resource/engine.js";
import { assertPathTenantScope } from "../tenant.js";

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
  code?: string;
  flow?: string;
  apply?: boolean;
}
interface ApplyMenuOptions {
  env?: string;
  code?: string;
  name: string;
  parentCode?: string;
  featureCode?: string;
  rank: number;
  iconCls?: string;
  apply?: boolean;
}

const engine = new ResourceEngine(resourceAdapterRegistry);

/** Register the new resource-first command tree and retained domain workflows. */
export function registerResourceCommands(
  store: ConfigStore,
  root: Command
): void {
  const resource = root
    .command("resource")
    .description("按声明式资源契约查询、写入、比较和迁移（默认预览；不提供删除）")
    .addHelpText(
      "after",
      `
普通资源均由契约注册，契约包含查询/保存接口、分页策略、业务唯一键、可比较/可写字段、租户策略和能力开关。
内置普通资源：app-module、feature、feature-group、serial-number；特殊处理器：menu、bpm。
动作统一为 create、update、unchanged、blocked；传输失败立即停止，不自动重试。
特殊能力：menu 使用菜单树专用处理器；BPM 使用 eadp bpm inspect/configure 与 resource compare/sync bpm 工作流。
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
    .description("新增或更新资源；默认只生成计划，--apply 才写入并回查；不执行删除")
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
      const client = createClient(environment, contract.service, runtime.timeoutMs);
      const recorder = options.apply
        ? new OperationRecorder(
            new OperationLogStore(store.directory),
            `eadp resource write ${contract.id}`,
            environment.name
          )
        : undefined;
      try {
        const result = await engine.write(contract, client, input, {
          apply: options.apply === true,
          ...(environment.config.tenantCode === undefined ? {} : { targetTenantCode: environment.config.tenantCode }),
          ...(recorder ? { recorder } : {})
        });
        const operationId = await recorder?.complete();
        printValue(
          { ...result, environment: environment.name, ...(operationId ? { operationId } : {}) },
          runtime.compact
        );
      } catch (error) {
        await recorder?.fail(error);
        throw operationError(error, recorder);
      }
    });

  addResourceFilterOptions(resource
    .command("compare")
    .description("只读比较两个环境，输出统一 change plan")
    .argument("<name>", "资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称")
    .option("--code <code>", "菜单代码；仅 menu 特殊处理器使用")
    .option("--flow <code-or-name>", "BPM 流程代码、名称或 Entity 代码；仅 bpm 特殊处理器使用"), false)
    .action(async (name: string, options: ResourceMigrationOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "compare");
      const { source, target } = await resolveMigrationEnvironments(store, options);
      assertMigrationTenants(contract, sourceForTenant(source), sourceForTenant(target));
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      validateSelectorOptions(contract, options);
      const special = getSpecialHandler(contract, "compare");
      if (special?.compare) {
        if (filters.length > 0) throw new CliError(`资源 ${contract.id} 的特殊比较不支持通用过滤条件`);
        const result = await special.compare({
          source,
          target,
          runtime,
          ...(options.code === undefined ? {} : { code: options.code }),
          ...(options.flow === undefined ? {} : { flow: options.flow }),
          apply: false
        });
        printValue(result, runtime.compact);
        return;
      }
      const result = await engine.compare(
        contract,
        createClient(source, contract.service, runtime.timeoutMs),
        createClient(target, contract.service, runtime.timeoutMs),
        { source: source.name, target: target.name },
        {
          sourceQuery: { filters },
          ...(target.config.tenantCode === undefined ? {} : { targetTenantCode: target.config.tenantCode })
        }
      );
      printValue(result, runtime.compact);
    });

  addResourceFilterOptions(resource
    .command("sync")
    .description("复用 compare change plan；默认预览，--apply 执行安全 create/update 并回查")
    .argument("<name>", "资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称")
    .option("--code <code>", "菜单代码；仅 menu 特殊处理器使用")
    .option("--flow <code-or-name>", "BPM 流程代码、名称或 Entity 代码；仅 bpm 特殊处理器使用")
    .option("--apply", "执行同步；blocked 记录会跳过"), false)
    .action(async (name: string, options: ResourceMigrationOptions) => {
      const contract = getResourceContract(name);
      assertCapability(contract, "sync");
      const { source, target } = await resolveMigrationEnvironments(store, options);
      assertMigrationTenants(contract, sourceForTenant(source), sourceForTenant(target));
      const runtime = getRuntimeOptions(root);
      const filters = buildResourceFilters(contract, options);
      validateSelectorOptions(contract, options);
      const special = getSpecialHandler(contract, "sync");
      if (special?.sync) {
        if (filters.length > 0) throw new CliError(`资源 ${contract.id} 的特殊迁移不支持通用过滤条件`);
        const result = await special.sync({
          source,
          target,
          store,
          runtime,
          ...(options.code === undefined ? {} : { code: options.code }),
          ...(options.flow === undefined ? {} : { flow: options.flow }),
          apply: options.apply === true
        });
        printValue(result, runtime.compact);
        return;
      }
      const recorder = options.apply
        ? new OperationRecorder(
            new OperationLogStore(store.directory),
            `eadp resource sync ${contract.id}`,
            target.name
          )
        : undefined;
      try {
        const result = await engine.sync(
          contract,
          createClient(source, contract.service, runtime.timeoutMs),
          createClient(target, contract.service, runtime.timeoutMs),
          { source: source.name, target: target.name },
          {
            apply: options.apply === true,
            sourceQuery: { filters },
            ...(target.config.tenantCode === undefined ? {} : { targetTenantCode: target.config.tenantCode }),
            ...(recorder ? { recorder } : {})
          }
        );
        const operationId = await recorder?.complete();
        printValue({ ...result, ...(operationId ? { operationId } : {}) }, runtime.compact);
      } catch (error) {
        await recorder?.fail(error);
        throw operationError(error, recorder);
      }
    });

  registerMenuCommands(root, store);
}

interface SpecialResourceHandler {
  query?(options: {
    environment: ResolvedEnvironment;
    runtime: RuntimeOptions;
    filters: ResourceFilter[];
    quick?: string;
  }): Promise<{ kind: string; resource: string; environment: string; items: ResourceRecord[]; total: number }>;
  compare?(options: {
    source: ResolvedEnvironment;
    target: ResolvedEnvironment;
    runtime: RuntimeOptions;
    code?: string;
    flow?: string;
    apply: boolean;
  }): Promise<Record<string, unknown>>;
  sync?(options: {
    source: ResolvedEnvironment;
    target: ResolvedEnvironment;
    store: ConfigStore;
    runtime: RuntimeOptions;
    code?: string;
    flow?: string;
    apply: boolean;
  }): Promise<Record<string, unknown>>;
}

const specialResourceHandlers: Record<string, SpecialResourceHandler> = {
  menu: {
    async query({ environment, runtime, filters, quick }) {
      const menus = await loadMenus(createClient(environment, "sei-basic", runtime.timeoutMs));
      const items = filterMenus(menus, filters, quick);
      return {
        kind: "eadp.resource.query.v1",
        resource: "menu",
        environment: environment.name,
        items,
        total: items.length
      };
    },
    async compare({ source, target, runtime, code }) {
      return syncMenus({
        sourceClient: createClient(source, "sei-basic", runtime.timeoutMs),
        targetClient: createClient(target, "sei-basic", runtime.timeoutMs),
        sourceEnvironment: source.name,
        targetEnvironment: target.name,
        ...(code === undefined ? {} : { code }),
        apply: false
      });
    },
    async sync({ source, target, store, runtime, code, apply }) {
      const recorder = apply
        ? new OperationRecorder(new OperationLogStore(store.directory), "eadp resource sync menu", target.name)
        : undefined;
      return syncMenus({
        sourceClient: createClient(source, "sei-basic", runtime.timeoutMs),
        targetClient: createClient(target, "sei-basic", runtime.timeoutMs),
        sourceEnvironment: source.name,
        targetEnvironment: target.name,
        ...(code === undefined ? {} : { code }),
        apply,
        ...(recorder ? { recorder } : {})
      });
    }
  },
  bpm: {
    async compare({ source, target, runtime, flow }) {
      return runBpmSync({ source, target, runtime, ...(flow === undefined ? {} : { flow }), apply: false });
    },
    async sync({ source, target, store, runtime, flow, apply }) {
      return runBpmSync({ source, target, store, runtime, ...(flow === undefined ? {} : { flow }), apply });
    }
  }
};

async function runBpmSync(options: {
  source: ResolvedEnvironment;
  target: ResolvedEnvironment;
  store?: ConfigStore;
  runtime: RuntimeOptions;
  flow?: string;
  apply: boolean;
}): Promise<Record<string, unknown>> {
  if (!options.flow || options.flow.trim() === "") {
    throw new CliError("resource bpm compare/sync 必须提供 --flow 流程代码、名称或 Entity 代码");
  }
  const recorder = options.apply && options.store
    ? new OperationRecorder(
        new OperationLogStore(options.store.directory),
        "eadp resource sync bpm",
        options.target.name
      )
    : undefined;
  try {
    const result = await syncBpmFlow({
      sourceClient: new BpmClient({
        baseUrl: options.source.config.baseUrl,
        token: options.source.token,
        authorization: options.source.authorization,
        timeoutMs: options.runtime.timeoutMs
      }),
      targetClient: new BpmClient({
        baseUrl: options.target.config.baseUrl,
        token: options.target.token,
        authorization: options.target.authorization,
        timeoutMs: options.runtime.timeoutMs
      }),
      sourceEnvironment: options.source.name,
      targetEnvironment: options.target.name,
      selector: options.flow,
      apply: options.apply,
      ...(recorder ? { recorder } : {})
    });
    const operationId = await recorder?.complete();
    return { ...result, ...(operationId ? { operationId } : {}) };
  } catch (error) {
    await recorder?.fail(error);
    throw operationError(error, recorder);
  }
}

function registerMenuCommands(root: Command, store: ConfigStore): void {
  const menu = root
    .command("menu")
    .description("执行菜单树专用操作");
  menu
    .command("create")
    .description("按菜单代码安全新增菜单；默认只预览；仅允许 global 租户")
    .requiredOption("--name <name>", "菜单名称")
    .option("--code <code>", "菜单代码；最多20个字符；省略时由服务端给号")
    .option("--parent-code <code>", "父菜单代码")
    .option("--feature-code <code>", "绑定的功能项代码")
    .option("--rank <number>", "菜单顺序", parseNonNegativeInteger, 0)
    .option("--icon-cls <class>", "菜单图标类")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行新增；默认预览")
    .addHelpText("after", "\n正式新增后回查菜单，并返回可用于显式 rollback 的 operationId。")
    .action(async (options: ApplyMenuOptions) => {
      assertMenuCodeLength(options.code);
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertPathTenantScope(resolved.config.tenantCode, "/api-gateway/sei-basic/menu", resolved.name);
      const runtime = getRuntimeOptions(root);
      const client = createClient(resolved, "sei-basic", runtime.timeoutMs);
      const menus = await loadMenus(client);
      const parent = options.parentCode ? selectMenuByCode(menus, options.parentCode, "父菜单") : undefined;
      if (parent) assertCanBeParent(parent);
      const feature = options.featureCode ? await resolveFeatureId(client, options.featureCode) : undefined;
      const desired: ResourceRecord = {
        ...(options.code ? { code: options.code } : {}),
        name: options.name,
        rank: options.rank,
        parentCode: parent?.code ?? null,
        featureCode: feature?.code ?? null,
        ...(options.iconCls === undefined ? {} : { iconCls: options.iconCls })
      };
      const existing = options.code
        ? menus.find((menu) => menu.code.toLocaleLowerCase() === options.code!.toLocaleLowerCase())
        : undefined;
      if (existing) {
        const fields = ["name", "rank", "parentCode", "featureCode", ...(options.iconCls === undefined ? [] : ["iconCls"])] as const;
        const conflicts = fields.filter((field) => JSON.stringify(logicalMenu(existing)[field] ?? null) !== JSON.stringify(desired[field] ?? null));
        if (conflicts.length) throw new CliError(`菜单 code=${options.code} 已存在且字段不同：${conflicts.join(", ")}；新增命令不会覆盖已有菜单`);
        printValue({ kind: "eadp.menu.apply.v1", environment: resolved.name, applied: false, action: "unchanged", desired, existing, verified: true }, runtime.compact);
        return;
      }
      if (!options.apply) {
        printValue({ kind: "eadp.menu.apply.v1", environment: resolved.name, applied: false, action: "create", desired, verified: true }, runtime.compact);
        return;
      }
      const recorder = new OperationRecorder(new OperationLogStore(store.directory), "eadp menu create", resolved.name);
      const payload: ResourceRecord = {
        ...(options.code ? { code: options.code } : {}), name: options.name, rank: options.rank,
        ...(parent ? { parentId: requireRecordId(parent, `父菜单 ${parent.code}`) } : {}),
        ...(feature ? { featureId: feature.id } : {}),
        ...(options.iconCls === undefined ? {} : { iconCls: options.iconCls })
      };
      try {
        const saved = await client.save("menu", payload);
        const savedCode = typeof saved.code === "string" && saved.code ? saved.code : options.code;
        if (!savedCode) throw new CliError("menu/save 未返回服务端生成的菜单代码");
        await recorder.recordAction({ type: "create-entity", service: "sei-basic", resource: "menu", entityId: String(saved.id), expected: payload, deleteMethod: "DELETE" });
        const actual = selectMenuByCode(await loadMenus(client), savedCode, "新增菜单");
        const verified = ["code", "name", "rank", "parentCode", "featureCode", ...(options.iconCls === undefined ? [] : ["iconCls"])].every((field) => JSON.stringify(logicalMenu(actual)[field] ?? null) === JSON.stringify({ ...desired, code: savedCode }[field] ?? null));
        if (!verified) throw new CliError("菜单新增后回查失败");
        const operationId = await recorder.complete();
        printValue({ kind: "eadp.menu.apply.v1", environment: resolved.name, applied: true, action: "create", desired: { ...desired, code: savedCode }, actual, operationId, verified }, runtime.compact);
      } catch (error) {
        await recorder.fail(error);
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
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
  return new ResourceClient({ baseUrl: environment.config.baseUrl, token: environment.token, authorization: environment.authorization, service, timeoutMs });
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
  options: { code?: string; flow?: string }
): void {
  if (options.code !== undefined && !contract.selectors?.includes("code")) {
    throw new CliError(`--code 不适用于资源 ${contract.id}`);
  }
  if (options.flow !== undefined && !contract.selectors?.includes("flow")) {
    throw new CliError(`--flow 不适用于资源 ${contract.id}`);
  }
}

function getSpecialHandler(
  contract: ResourceContract,
  capability: "query" | "compare" | "sync"
): SpecialResourceHandler | undefined {
  if (!contract.handler) return undefined;
  const handler = specialResourceHandlers[contract.handler];
  if (!handler || typeof handler[capability] !== "function") {
    throw new CliError(`资源 ${contract.id} 的 ${capability} 处理器未注册`);
  }
  return handler;
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
function parseNonNegativeInteger(source: string): number {
  const value = Number(source);
  if (!Number.isInteger(value) || value < 0) throw new CliError(`菜单顺序无效：${source}`);
  return value;
}
function requireRecordId(record: ResourceRecord, label: string): string {
  if (typeof record.id !== "string" || !record.id) throw new CliError(`${label} 缺少有效 ID`);
  return record.id;
}
function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRecordOrArray(value: unknown): value is ResourceRecord | ResourceRecord[] {
  return isRecord(value) || (Array.isArray(value) && value.every(isRecord));
}
