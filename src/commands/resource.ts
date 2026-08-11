import { Option, type Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { syncBpmFlow } from "../bpm/sync.js";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { printJsonLine, printValue } from "../io.js";
import {
  assertCanBeParent,
  filterMenus,
  loadMenus,
  logicalMenu,
  resolveFeatureId,
  selectMenuByCode,
  syncMenus
} from "../menu/service.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import {
  ResourceClient,
  type ResourceFilter,
  type ResourceRecord
} from "../resource/client.js";
import {
  DependencyResolutionError,
  getResourceSpec,
  listResourceSpecs,
  RecordMappingError,
  type BlockingIssue,
  type MissingDependency,
  type ResourceSpec
} from "../resource/specs.js";
import { getRuntimeOptions, type RuntimeOptions } from "../runtime-options.js";
import { assertPathTenantScope } from "../tenant.js";
import type { VerbCommands } from "./verbs.js";

interface QueryOptions {
  env?: string;
  service: string;
  entityClass?: string;
  configType?: string;
  createdIn?: string;
  from?: string;
  to?: string;
  timeField: string;
  filter: string[];
  quick?: string;
}

interface SyncOptions {
  source: string;
  target: string;
  createdIn?: string;
  from?: string;
  to?: string;
  timeField: string;
  entityClass?: string;
  configType?: string;
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

export function registerResourceCommands(
  commands: Pick<VerbCommands, "inspect" | "query" | "apply" | "sync">,
  store: ConfigStore,
  root: Command
): void {
  commands.inspect
    .command("resource")
    .description("查看已注册的跨环境同步资源类型")
    .argument("[resource]", "注册资源名；省略时列出全部")
    .action((resourceName?: string) => {
      if (!resourceName) {
        printValue(
          {
            kind: "eadp.resource.catalog.v1",
            resources: listResourceSpecs()
          },
          getRuntimeOptions(root).compact
        );
        return;
      }
      const spec = getResourceSpec(resourceName);
      printValue(
        {
          kind: "eadp.resource.catalog.v1",
          resource: resourceName,
          service: spec.service,
          endpoint: spec.endpoint,
          identityField: spec.identityField,
          writableFields: spec.writableFields
        },
        getRuntimeOptions(root).compact
      );
    });

  commands.apply
    .command("menu")
    .description("按菜单代码安全新增菜单；默认只预览")
    .requiredOption("--name <name>", "菜单名称")
    .option("--code <code>", "菜单代码；省略时由服务端给号")
    .option("--parent-code <code>", "父菜单代码；省略时新增根菜单")
    .option("--feature-code <code>", "绑定的功能项代码")
    .option("--rank <number>", "菜单顺序", parseNonNegativeInteger, 0)
    .option("--icon-cls <class>", "菜单图标类")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行新增；不提供时仅输出预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply menu --name 采购管理 --code PURCHASING
  eadp apply menu --name 采购申请 --code PURCHASING_APPLY \\
    --parent-code PURCHASING --feature-code PURCHASE_APPLY --rank 10 --apply

父菜单和功能项均按 code 唯一解析；不会接受或复制其他环境的 ID。新增成功会返回 operationId。`
    )
    .action(async (options: ApplyMenuOptions) => {
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
        if (conflicts.length) {
          throw new CliError(`菜单 code=${options.code} 已存在且字段不同：${conflicts.join(", ")}；新增命令不会覆盖已有菜单`);
        }
        printValue({
          kind: "eadp.menu.apply.v1",
          environment: resolved.name,
          applied: false,
          action: "unchanged",
          desired,
          existing,
          verified: true
        }, runtime.compact);
        return;
      }
      if (!options.apply) {
        printValue({
          kind: "eadp.menu.apply.v1",
          environment: resolved.name,
          applied: false,
          action: "create",
          desired,
          verified: true
        }, runtime.compact);
        return;
      }
      const recorder = new OperationRecorder(new OperationLogStore(store.directory), "eadp apply menu", resolved.name);
      const payload: ResourceRecord = {
        ...(options.code ? { code: options.code } : {}),
        name: options.name,
        rank: options.rank,
        ...(parent ? { parentId: requireRecordId(parent, `父菜单 ${parent.code}`) } : {}),
        ...(feature ? { featureId: feature.id } : {}),
        ...(options.iconCls === undefined ? {} : { iconCls: options.iconCls })
      };
      try {
        const saved = await client.save("menu", payload);
        const savedCode = typeof saved.code === "string" && saved.code ? saved.code : options.code;
        if (!savedCode) throw new CliError("menu/save 未返回服务端生成的菜单代码");
        await recorder.recordAction({
          type: "create-entity",
          service: "sei-basic",
          resource: "menu",
          entityId: String(saved.id),
          expected: {
            ...Object.fromEntries(Object.entries(payload).filter(([field]) => ["code", "name", "rank", "parentId", "featureId", "iconCls"].includes(field))),
            code: savedCode
          },
          deleteMethod: "DELETE"
        });
        const actual = selectMenuByCode(await loadMenus(client), savedCode, "新增菜单");
        const expected: ResourceRecord = { ...desired, code: savedCode };
        const verified = ["code", "name", "rank", "parentCode", "featureCode", ...(options.iconCls === undefined ? [] : ["iconCls"])]
          .every((field) => JSON.stringify(logicalMenu(actual)[field] ?? null) === JSON.stringify(expected[field] ?? null));
        if (!verified) throw new CliError("菜单新增后回查失败");
        const operationId = await recorder.complete();
        printValue({
          kind: "eadp.menu.apply.v1",
          environment: resolved.name,
          applied: true,
          action: "create",
          desired: expected,
          actual,
          operationId,
          verified
        }, runtime.compact);
      } catch (error) {
        await recorder.fail(error);
        const suffix = recorder.hasActions ? `；可使用 operation-id ${recorder.operationId} 回滚已新增菜单` : "";
        throw new CliError(`${error instanceof Error ? error.message : String(error)}${suffix}`);
      }
    });

  commands.query
    .argument("<resource>", "资源接口名，例如 feature、dataRole")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--service <name>", "网关服务名", "sei-basic")
    .option("--entity-class <name>", "给号配置实体完整类名；仅用于 serialNumberConfig")
    .option("--config-type <type>", "给号配置类型；serialNumberConfig 默认为 CODE_TYPE")
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
    .addHelpText(
      "after",
      `
示例：
  eadp query feature --env dev --created-in 2026-07
  eadp query feature --env dev --filter appModuleCode:EQ:BASIC
  eadp query menu --env global --quick 采购
  eadp query serialNumberConfig --env global --entity-class com.example.Order

输出：NDJSON；依次输出 meta、逐条 item 和最终 summary。`
    )
    .action(async (resourceName: string, options: QueryOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      assertPathTenantScope(
        resolved.config.tenantCode,
        `/api-gateway/${options.service}/${resourceName}`,
        resolved.name
      );
      const runtime = getRuntimeOptions(root);
      const serialQuery = resourceName.toLocaleLowerCase() === "serialnumberconfig";
      if (!serialQuery && (options.entityClass || options.configType)) {
        throw new CliError("--entity-class 和 --config-type 仅适用于 serialNumberConfig");
      }
      const filters = buildFilters(options);
      if (serialQuery) {
        if (options.entityClass) {
          filters.push({
            fieldName: "entityClassName",
            operator: "EQ",
            value: options.entityClass
          });
        }
        filters.push({
          fieldName: "configType",
          operator: "EQ",
          value: options.configType ?? "CODE_TYPE"
        });
      }
      const client = createClient(resolved, options.service, runtime.timeoutMs);
      await printJsonLine({
        kind: "eadp.resource.query.meta.v1",
        environment: resolved.name,
        service: options.service,
        resource: resourceName,
        filters
      });
      const serialIdentities = serialQuery ? new Set<string>() : undefined;
      let total = 0;
      if (resourceName.toLocaleLowerCase() === "menu") {
        if (options.service !== "sei-basic") throw new CliError("menu 查询仅支持 sei-basic 服务");
        const menus = filterMenus(await loadMenus(client), filters, options.quick);
        for (const item of menus) {
          total += 1;
          await printJsonLine({ kind: "eadp.resource.query.item.v1", index: total, item });
        }
        await printJsonLine({ kind: "eadp.resource.query.summary.v1", total });
        return;
      }
      for await (const page of client.iterateByPage(resourceName, {
        filters,
        ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
      })) {
        for (const item of page) {
          if (serialIdentities) {
            validateSerialNumberIdentityItem(serialIdentities, item);
          }
          total += 1;
          await printJsonLine({
            kind: "eadp.resource.query.item.v1",
            index: total,
            item
          });
        }
      }
      const identity = serialQuery
        ? buildSerialNumberIdentity(total, options.entityClass)
        : undefined;
      await printJsonLine({
        kind: "eadp.resource.query.summary.v1",
        total,
        ...(identity === undefined ? {} : { identity })
      });
    });

  commands.sync
    .argument("<resource>", "注册资源名")
    .requiredOption("--source <env>", "源环境名称")
    .requiredOption("--target <env>", "目标环境名称")
    .option("--created-in <yyyy-mm>", "只处理该创建月份的源资源")
    .option("--from <datetime>", "源资源起始时间，包含")
    .option("--to <datetime>", "源资源结束时间，不包含")
    .option("--time-field <name>", "时间字段", "createdDate")
    .option("--entity-class <name>", "给号配置实体完整类名；仅用于 serial-number")
    .option("--config-type <type>", "给号配置类型；serial-number 默认为 CODE_TYPE")
    .option("--code <code>", "按业务代码筛选；仅用于 feature-group")
    .option("--flow <code-or-name>", "BPM 流程代码、名称或实体代码；仅用于 bpm")
    .option("--apply", "执行目标环境写入；默认只预览")
    .addHelpText(
      "after",
      `
示例：
  eadp sync feature --source dev --target test --created-in 2026-07
  eadp sync feature --source dev --target test --created-in 2026-07 --apply
  eadp sync feature-group --source dev --target test --code ISRM-PA-OLD-2
  eadp sync menu --source global-dev --target global-test --code PURCHASING
  eadp sync bpm --source dev --target test --flow 采购申请
  eadp sync serial-number --source global-dev --target global-test --entity-class com.example.Order

给号配置枚举（参数和数据中必须使用枚举名称）：
  ConfigType: CODE_TYPE, BAR_TYPE
  CycleStrategy: MAX_CYCLE, DAY_CYCLE, MONTH_CYCLE, YEAR_CYCLE
  ReturnStrategy: NEW, REPEAT, PATCH
  LinkCharacter: EMPTY, DASH, DOT, PIPE, COLON
  DefaultElement: FIXED_CODE, DATE_CODE, SERIAL_CODE

执行前会校验源、目标环境的租户条件；任一环境不满足时不会读取迁移数据。`
    )
    .action(async (resourceName: string, options: SyncOptions) => {
      await executeSync(store, resourceName, options, getRuntimeOptions(root));
    });
}

async function executeSync(
  store: ConfigStore,
  resourceName: string,
  options: SyncOptions,
  runtime: RuntimeOptions
): Promise<void> {
  if (options.source === options.target) {
    throw new CliError("源环境和目标环境不能相同");
  }
  const config = await store.load();
  const source = resolveEnvironment(config, options.source);
  const target = resolveEnvironment(config, options.target);
  if (resourceName.trim().toLocaleLowerCase() === "bpm") {
    if (!options.flow) throw new CliError("sync bpm 必须提供 --flow <code-or-name>");
    if (options.entityClass || options.configType || options.code || options.createdIn || options.from || options.to) {
      throw new CliError("sync bpm 仅接受 --source、--target、--flow 和 --apply");
    }
    assertPathTenantScope(source.config.tenantCode, "/api-gateway/sei-bpm/conFlowType", source.name);
    assertPathTenantScope(target.config.tenantCode, "/api-gateway/sei-bpm/conFlowType", target.name);
    const recorder = options.apply
      ? new OperationRecorder(new OperationLogStore(store.directory), "eadp sync bpm", target.name)
      : undefined;
    const result = await syncBpmFlow({
      sourceClient: new BpmClient({
        baseUrl: source.config.baseUrl,
        token: source.token,
        timeoutMs: runtime.timeoutMs
      }),
      targetClient: new BpmClient({
        baseUrl: target.config.baseUrl,
        token: target.token,
        timeoutMs: runtime.timeoutMs
      }),
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      selector: options.flow,
      apply: options.apply === true,
      ...(recorder ? { recorder } : {})
    });
    const operationId = await recorder?.complete();
    printValue(operationId ? { ...result, operationId } : result, runtime.compact);
    return;
  }
  if (options.flow) throw new CliError("--flow 仅适用于 bpm");
  if (resourceName.trim().toLocaleLowerCase() === "menu") {
    if (options.entityClass || options.configType || options.createdIn || options.from || options.to) {
      throw new CliError("sync menu 仅接受 --source、--target、--code 和 --apply");
    }
    assertPathTenantScope(source.config.tenantCode, "/api-gateway/sei-basic/menu", source.name);
    assertPathTenantScope(target.config.tenantCode, "/api-gateway/sei-basic/menu", target.name);
    const recorder = options.apply
      ? new OperationRecorder(new OperationLogStore(store.directory), "eadp sync menu", target.name)
      : undefined;
    const result = await syncMenus({
      sourceClient: createClient(source, "sei-basic", runtime.timeoutMs),
      targetClient: createClient(target, "sei-basic", runtime.timeoutMs),
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      ...(options.code ? { code: options.code } : {}),
      apply: options.apply === true,
      ...(recorder ? { recorder } : {})
    });
    printValue(result, runtime.compact);
    return;
  }
  const spec = getResourceSpec(resourceName);
  assertMigrationTenantScope(source, target, spec);
  const sourceClient = createClient(source, spec.service, runtime.timeoutMs);
  const targetClient = createClient(target, spec.service, runtime.timeoutMs);
  const filters = buildFilters({
    ...(options.createdIn === undefined ? {} : { createdIn: options.createdIn }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    timeField: options.timeField,
    filter: []
  });
  const targetFilters: ResourceFilter[] = [];
  const serialSync = spec.name === "serial-number";
  if (!serialSync && (options.entityClass || options.configType)) {
    throw new CliError("--entity-class 和 --config-type 仅适用于 serial-number");
  }
  if (serialSync) {
    if (options.entityClass) {
      const entityClassFilter = {
        fieldName: "entityClassName",
        operator: "EQ",
        value: options.entityClass
      } satisfies ResourceFilter;
      filters.push(entityClassFilter);
      targetFilters.push(entityClassFilter);
    }
    const configTypeFilter = {
      fieldName: "configType",
      operator: "EQ",
      value: options.configType ?? "CODE_TYPE"
    } satisfies ResourceFilter;
    filters.push(configTypeFilter);
    targetFilters.push(configTypeFilter);
  }
  const featureGroupSync = spec.name === "feature-group";
  if (options.code && !featureGroupSync) {
    throw new CliError("--code 仅适用于 feature-group 和 menu");
  }
  if (featureGroupSync && options.code) {
    const codeFilter = { fieldName: "code", operator: "EQ", value: options.code } satisfies ResourceFilter;
    filters.push(codeFilter);
    targetFilters.push(codeFilter);
  }
  const [sourcePage, targetPage] = await Promise.all([
    sourceClient.findByPage(spec.endpoint, { filters }),
    targetClient.findByPage(spec.endpoint, { filters: targetFilters })
  ]);
  const changes: Array<{
    key: string;
    action: "create" | "update" | "unchanged" | "blocked";
    changedFields: string[];
    before: ResourceRecord | null;
    desired: ResourceRecord | null;
    missingDependencies?: MissingDependency[];
    blockingIssues?: BlockingIssue[];
  }> = [];
  assertUniqueIdentities(sourcePage.rows, spec, "源环境");
  assertUniqueIdentities(targetPage.rows, spec, "目标环境");
  for (const sourceRecord of sourcePage.rows) {
    const key = identityValue(sourceRecord, spec);
    const targetRecord = findByIdentity(targetPage.rows, spec, key);
    let desired: ResourceRecord;
    try {
      desired = await spec.toDesired(sourceRecord, targetClient, {
        targetTenantCode: target.config.tenantCode!
      });
    } catch (error) {
      if (error instanceof RecordMappingError) {
        changes.push({
          key,
          action: "blocked",
          changedFields: [],
          before: targetRecord ?? null,
          desired: null,
          blockingIssues: error.blockingIssues
        });
        continue;
      }
      if (!(error instanceof DependencyResolutionError)) throw error;
      changes.push({
        key,
        action: "blocked",
        changedFields: [],
        before: targetRecord ?? null,
        desired: null,
        missingDependencies: error.missingDependencies
      });
      continue;
    }
    if (serialSync && isMissingReturnStrategy(desired.returnStrategy)) {
      if (targetRecord === undefined) {
        desired.returnStrategy = "NEW";
      } else if ("returnStrategy" in targetRecord) {
        desired.returnStrategy = targetRecord.returnStrategy;
      } else {
        delete desired.returnStrategy;
      }
    }
    if (targetRecord && typeof targetRecord.id === "string") {
      desired.id = targetRecord.id;
      for (const field of spec.preserveTargetFields ?? []) {
        if (field in targetRecord) {
          desired[field] = targetRecord[field];
        }
      }
    }
    let changedFields: string[];
    try {
      changedFields = diffFields(targetRecord, desired, spec);
    } catch (error) {
      if (!(error instanceof RecordMappingError)) throw error;
      changes.push({
        key,
        action: "blocked",
        changedFields: [],
        before: targetRecord ?? null,
        desired: null,
        blockingIssues: error.blockingIssues
      });
      continue;
    }
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

  const writable = changes.filter(
    (change) => change.action === "create" || change.action === "update"
  );
  const blocked = changes.filter((change) => change.action === "blocked");
  const recorder = options.apply
    ? new OperationRecorder(
        new OperationLogStore(store.directory),
        `eadp sync ${resourceName}`,
        target.name
      )
    : undefined;
  if (options.apply) {
    for (const change of writable) {
      const saved = await targetClient.save(spec.endpoint, change.desired!);
      if (change.action === "create") {
        await recorder!.recordAction({
          type: "create-entity",
          service: "sei-basic",
          resource: spec.endpoint,
          entityId: String(saved.id),
          expected: change.desired!,
          deleteMethod: spec.name === "serial-number" ? "POST" : "DELETE"
        });
      }
    }
  }

  let verified = !options.apply;
  if (options.apply) {
    const after = await targetClient.findByPage(spec.endpoint, { filters: targetFilters });
    verified = changes
      .filter((change) => change.action !== "blocked")
      .every((change) => {
      const targetRecord = findByIdentity(after.rows, spec, change.key);
      return (
        targetRecord !== undefined &&
        change.desired !== null &&
        diffFields(targetRecord, change.desired, spec).length === 0
      );
      });
    if (!verified) {
      throw new CliError("资源同步写入后回查失败");
    }
  }

  const operationId = await recorder?.complete();
  printValue(
    {
      kind: "eadp.resource.sync.v1",
      resource: resourceName,
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      filters,
      applied: options.apply === true && writable.length > 0,
      skippedBlocked: options.apply ? blocked.length : 0,
      summary: {
        create: changes.filter((change) => change.action === "create").length,
        update: changes.filter((change) => change.action === "update").length,
        unchanged: changes.filter((change) => change.action === "unchanged").length,
        blocked: blocked.length
      },
      missingDependencies: uniqueMissingDependencies(blocked),
      blockingIssues: uniqueBlockingIssues(blocked),
      changes,
      ...(operationId ? { operationId } : {}),
      verified
    },
    runtime.compact
  );
}

function isMissingReturnStrategy(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function uniqueBlockingIssues(
  blocked: Array<{ blockingIssues?: BlockingIssue[] }>
): BlockingIssue[] {
  const issues = new Map<string, BlockingIssue>();
  for (const change of blocked) {
    for (const issue of change.blockingIssues ?? []) {
      const key = [issue.resource, issue.field, issue.reason, issue.message].join(":");
      issues.set(key, issue);
    }
  }
  return [...issues.values()];
}

function uniqueMissingDependencies(
  blocked: Array<{ missingDependencies?: MissingDependency[] }>
): MissingDependency[] {
  const dependencies = new Map<string, MissingDependency>();
  for (const change of blocked) {
    for (const dependency of change.missingDependencies ?? []) {
      const key = [
        dependency.resource,
        dependency.identityField,
        dependency.value.toLocaleLowerCase(),
        dependency.reason
      ].join(":");
      dependencies.set(key, dependency);
    }
  }
  return [...dependencies.values()];
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
  timeoutMs: number
): ResourceClient {
  return new ResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    service,
    timeoutMs
  });
}

function buildSerialNumberIdentity(
  total: number,
  selectedEntityClass?: string
):
  | {
      field: "entityClassName";
      value: string;
      exists: boolean;
      unique: true;
    }
  | undefined {
  return selectedEntityClass
    ? {
        field: "entityClassName",
        value: selectedEntityClass,
        exists: total === 1,
        unique: true
      }
    : undefined;
}

function validateSerialNumberIdentityItem(
  identities: Set<string>,
  item: ResourceRecord
): void {
  const value = item.entityClassName;
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError("给号配置缺少有效 entityClassName");
  }
  const key = value.trim().toLocaleLowerCase();
  if (identities.has(key)) {
    throw new CliError(`给号配置 entityClassName 不唯一：${value}（匹配至少 2 条）`);
  }
  identities.add(key);
}

function buildFilters(
  options: Pick<QueryOptions, "createdIn" | "from" | "to" | "timeField" | "filter">
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
      filters.push({ fieldName: options.timeField, operator: "GE", value: options.from });
    }
    if (options.to) {
      filters.push({ fieldName: options.timeField, operator: "LT", value: options.to });
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
  return source.trim() !== "" && Number.isFinite(numberValue) ? numberValue : source;
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
    return typeof candidate === "string" && candidate.toLocaleLowerCase() === normalized;
  });
  if (matches.length > 1) {
    throw new CliError(`目标环境业务唯一键重复：${spec.identityField}=${value}`);
  }
  return matches[0];
}

function diffFields(
  before: ResourceRecord | undefined,
  desired: ResourceRecord,
  spec: ResourceSpec
): string[] {
  if (!before) {
    return spec.writableFields.filter((field) => field in desired);
  }
  return spec.writableFields.filter(
    (field) =>
      JSON.stringify(spec.compareValue?.(before, field) ?? before[field]) !==
      JSON.stringify(spec.compareValue?.(desired, field) ?? desired[field])
  );
}

function assertUniqueIdentities(
  records: ResourceRecord[],
  spec: ResourceSpec,
  label: string
): void {
  const counts = new Map<string, { value: string; count: number }>();
  for (const record of records) {
    const value = identityValue(record, spec);
    const key = value.trim().toLocaleLowerCase();
    const current = counts.get(key);
    counts.set(key, { value, count: (current?.count ?? 0) + 1 });
  }
  const duplicate = [...counts.values()].find((item) => item.count > 1);
  if (duplicate) {
    throw new CliError(
      `${label}业务唯一键重复：${spec.identityField}=${duplicate.value}（匹配 ${duplicate.count} 条）`
    );
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseNonNegativeInteger(source: string): number {
  const value = Number(source);
  if (!Number.isInteger(value) || value < 0) throw new CliError(`菜单顺序无效：${source}`);
  return value;
}

function requireRecordId(record: ResourceRecord, label: string): string {
  if (typeof record.id !== "string" || !record.id) throw new CliError(`${label} 缺少有效 ID`);
  return record.id;
}
