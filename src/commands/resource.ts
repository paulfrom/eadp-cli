import { Option, type Command } from "commander";
import { BpmClient } from "../bpm/client.js";
import { syncBpmFlow } from "../bpm/sync.js";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { formatCompactNdjson, printJsonLine, printValue } from "../io.js";
import {
  assertCanBeParent,
  filterMenus,
  loadMenus,
  logicalMenu,
  resolveFeatureId,
  selectMenuByCode,
  syncMenus,
  assertMenuCodeLength
} from "../menu/service.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import {
  filterRecords,
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
          identityFields: resourceIdentityFields(spec),
          writableFields: spec.writableFields
        },
        getRuntimeOptions(root).compact
      );
    });

  commands.apply
    .command("menu")
    .description("按菜单代码安全新增菜单；默认只预览；仅允许 tenantCode === \"global\" 的全局管理员环境")
    .requiredOption("--name <name>", "菜单名称")
    .option("--code <code>", "菜单代码；最多20个字符；省略时由服务端给号")
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

父菜单和功能项均按 code 唯一解析；不会接受或复制其他环境的 ID。新增成功会返回 operationId。
菜单 code 最多20个字符；超长代码会在任何远端请求前拒绝。
菜单、功能项、功能项组和给号配置的远端操作均要求 tenantCode === "global"。`
    )
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
    .argument("<resource>", "资源接口名，例如 feature、feature-group、serial-number、dataRole")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--service <name>", "网关服务名", "sei-basic")
    .option("--entity-class <name>", "给号配置实体完整类名；仅用于 serial-number")
    .option("--config-type <type>", "给号配置类型；serial-number 默认为 CODE_TYPE")
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
  eadp query app-module --env global --filter code:EQ:ams
  eadp query menu --env global --quick 采购
  eadp query serial-number --env global --entity-class com.example.Order

serial-number 在 global 租户查询时会在现有过滤条件后自动追加
publicFlag=true（fieldType=java.lang.Boolean）；sync serial-number 不受此默认过滤器影响。
应用模块（app-module）、菜单（menu）、功能项（feature）、功能项组（feature-group）和给号（serial-number）
只有 tenantCode === "global" 的环境才允许查询。
给号配置业务唯一键为 entityClassName + tenantCode（按记录实际值规范化判重）；
configType 仅作为查询/同步筛选条件，不参与业务唯一键。选择 --entity-class 时，summary.identity
输出全部匹配记录的复合键 values；缺少任一键字段会明确失败。

输出：默认 NDJSON（meta、逐条 item、summary）；使用 --output compact-ndjson 时首行是
含 type/schema 的 meta，后续每条是含 type/key/v 的 schema 对齐 row。`
    )
    .action(async (resourceName: string, options: QueryOptions) => {
      const resolved = resolveEnvironment(await store.load(), options.env);
      const queryResource = normalizeQueryResource(resourceName);
      assertPathTenantScope(
        resolved.config.tenantCode,
        `/api-gateway/${options.service}/${queryResource.endpoint}`,
        resolved.name
      );
      const runtime = getRuntimeOptions(root);
      const serialQuery = queryResource.serial;
      if (!serialQuery && (options.entityClass || options.configType)) {
        throw new CliError("--entity-class 和 --config-type 仅适用于 serial-number");
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
        if (resolved.config.tenantCode === "global") {
          filters.push({
            fieldName: "publicFlag",
            fieldType: "java.lang.Boolean",
            operator: "EQ",
            value: true
          });
        }
      }
      const client = createClient(resolved, options.service, runtime.timeoutMs);
      const compactNdjson = runtime.output === "compact-ndjson";
      const compactRows: ResourceRecord[] = [];
      if (!compactNdjson) {
        await printJsonLine({
          kind: "eadp.resource.query.meta.v1",
          environment: resolved.name,
          service: options.service,
          resource: resourceName,
          filters
        });
      }
      const serialIdentities = serialQuery
        ? { keys: new Set<string>(), values: [] as SerialNumberIdentityValue[] }
        : undefined;
      let total = 0;
      if (queryResource.menu) {
        if (options.service !== "sei-basic") throw new CliError("menu 查询仅支持 sei-basic 服务");
        const menus = filterMenus(await loadMenus(client), filters, options.quick);
        for (const item of menus) {
          total += 1;
          if (compactNdjson) {
            compactRows.push(item);
          } else {
            await printJsonLine({ kind: "eadp.resource.query.item.v1", index: total, item });
          }
        }
        if (compactNdjson) {
          process.stdout.write(formatCompactNdjson(compactRows, {
            meta: {
              environment: resolved.name,
              service: options.service,
              resource: resourceName,
              filters
            },
            count: total
          }));
        } else {
          await printJsonLine({ kind: "eadp.resource.query.summary.v1", total });
        }
        return;
      }
      if (queryResource.findAll) {
        const records = filterRecords(
          await client.findAll(queryResource.endpoint),
          filters,
          options.quick
        );
        for (const item of records) {
          if (serialIdentities) {
            validateSerialNumberIdentityItem(serialIdentities, item);
          }
          total += 1;
          if (compactNdjson) {
            compactRows.push(item);
          } else {
            await printJsonLine({
              kind: "eadp.resource.query.item.v1",
              index: total,
              item
            });
          }
        }
        const identity = serialQuery
          ? buildSerialNumberIdentity(serialIdentities?.values ?? [], options.entityClass)
          : undefined;
        if (compactNdjson) {
          process.stdout.write(formatCompactNdjson(compactRows, {
            meta: {
              environment: resolved.name,
              service: options.service,
              resource: resourceName,
              filters,
              ...(identity === undefined ? {} : { identity })
            },
            count: total
          }));
        } else {
          await printJsonLine({
            kind: "eadp.resource.query.summary.v1",
            total,
            ...(identity === undefined ? {} : { identity })
          });
        }
        return;
      }
      for await (const page of client.iterateByPage(queryResource.endpoint, {
        filters,
        ...(options.quick === undefined ? {} : { quickSearchValue: options.quick })
      })) {
        for (const item of page) {
          if (serialIdentities) {
            validateSerialNumberIdentityItem(serialIdentities, item);
          }
          total += 1;
          if (compactNdjson) {
            compactRows.push(item);
          } else {
            await printJsonLine({
              kind: "eadp.resource.query.item.v1",
              index: total,
              item
            });
          }
        }
      }
      const identity = serialQuery
        ? buildSerialNumberIdentity(serialIdentities?.values ?? [], options.entityClass)
        : undefined;
      if (compactNdjson) {
        process.stdout.write(formatCompactNdjson(compactRows, {
          meta: {
            environment: resolved.name,
            service: options.service,
            resource: resourceName,
            filters,
            ...(identity === undefined ? {} : { identity })
          },
          count: total
        }));
      } else {
        await printJsonLine({
          kind: "eadp.resource.query.summary.v1",
          total,
          ...(identity === undefined ? {} : { identity })
        });
      }
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
    .option("--code <code>", "按业务代码筛选；用于 feature-group 或 menu；菜单 code 最多20个字符")
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

serial-number 按 entityClassName + tenantCode 匹配；源记录使用各自实际 tenantCode
判重，目标匹配和 desired.tenantCode 使用目标环境的 tenantCode。configType 仅用于筛选，
不参与业务唯一键；缺少 entityClassName 或 tenantCode 的记录会明确失败。

菜单（menu）、功能项（feature）、功能项组（feature-group）和给号（serial-number）的同步，
源、目标环境均必须记录 tenantCode === "global"；任一环境不满足时不会读取迁移数据。`
    )
    .action(async (resourceName: string, options: SyncOptions) => {
      await executeSync(store, resourceName, options, getRuntimeOptions(root));
    });
}

interface QueryResource {
  endpoint: string;
  menu: boolean;
  serial: boolean;
  findAll: boolean;
}

function normalizeQueryResource(resourceName: string): QueryResource {
  const trimmed = resourceName.trim();
  if (trimmed === "app-module") {
    return { endpoint: "appModule", menu: false, serial: false, findAll: true };
  }
  if (trimmed === "feature-group") {
    return { endpoint: "featureGroup", menu: false, serial: false, findAll: true };
  }
  if (trimmed === "serial-number") {
    return { endpoint: "serialNumberConfig", menu: false, serial: true, findAll: false };
  }
  if (trimmed === "appModule" || trimmed === "featureGroup" || trimmed === "serialNumberConfig") {
    const canonical = trimmed === "appModule"
      ? "app-module"
      : trimmed === "featureGroup"
        ? "feature-group"
        : "serial-number";
    throw new CliError(`资源 ${trimmed} 不是 CLI 资源名；请使用 ${canonical}`);
  }
  const token = trimmed.toLocaleLowerCase();
  return {
    endpoint: trimmed,
    menu: token === "menu",
    serial: false,
    findAll: false
  };
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
  const findAllFeatureGroup = featureGroupSync;
  const [sourceRows, targetRows] = await Promise.all([
    findAllFeatureGroup
      ? sourceClient.findAll(spec.endpoint).then((records) => filterRecords(records, filters))
      : sourceClient.findByPage(spec.endpoint, { filters }).then((page) => page.rows),
    findAllFeatureGroup
      ? targetClient.findAll(spec.endpoint).then((records) => filterRecords(records, targetFilters))
      : targetClient.findByPage(spec.endpoint, { filters: targetFilters }).then((page) => page.rows)
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
  assertUniqueIdentities(sourceRows, spec, "源环境");
  assertUniqueIdentities(targetRows, spec, "目标环境");
  const mappedIdentityKeys = new Set<string>();
  for (const sourceRecord of sourceRows) {
    // Source uniqueness is checked against each record's actual tenantCode.
    // Matching and post-write verification use the target tenant for serial
    // number configurations because toDesired remaps tenantCode to that value.
    const sourceKey = identityValue(sourceRecord, spec);
    const key = serialSync
      ? identityValue(sourceRecord, spec, { tenantCode: target.config.tenantCode! })
      : sourceKey;
    const targetRecord = findByIdentity(targetRows, spec, key);
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
    if (spec.name === "feature" && (desired.tenantCanUse === undefined || desired.tenantCanUse === null)) {
      if (targetRecord === undefined) {
        desired.tenantCanUse = true;
      } else if ("tenantCanUse" in targetRecord) {
        desired.tenantCanUse = targetRecord.tenantCanUse;
      } else {
        delete desired.tenantCanUse;
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
    if (mappedIdentityKeys.has(key)) {
      throw new CliError(
        `源环境记录映射到目标环境后业务唯一键重复：${identityDescription(spec)}=${key}`
      );
    }
    mappedIdentityKeys.add(key);
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
    const after = findAllFeatureGroup
      ? filterRecords(await targetClient.findAll(spec.endpoint), targetFilters)
      : (await targetClient.findByPage(spec.endpoint, { filters: targetFilters })).rows;
    verified = changes
      .filter((change) => change.action !== "blocked")
      .every((change) => {
      const targetRecord = findByIdentity(after, spec, change.key);
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

interface SerialNumberIdentityValue {
  entityClassName: string;
  tenantCode: string;
}

interface SerialNumberIdentityState {
  keys: Set<string>;
  values: SerialNumberIdentityValue[];
}

function buildSerialNumberIdentity(
  values: SerialNumberIdentityValue[],
  selectedEntityClass?: string
):
  | {
      fields: ["entityClassName", "tenantCode"];
      values: SerialNumberIdentityValue[];
      exists: boolean;
      unique: true;
    }
  | undefined {
  return selectedEntityClass
    ? {
        fields: ["entityClassName", "tenantCode"],
        values,
        exists: values.length > 0,
        unique: true
      }
    : undefined;
}

function validateSerialNumberIdentityItem(
  identities: SerialNumberIdentityState,
  item: ResourceRecord
): void {
  const entityClassName = requiredIdentityPart(
    item.entityClassName,
    "entityClassName",
    "给号配置"
  );
  const tenantCode = requiredIdentityPart(item.tenantCode, "tenantCode", "给号配置");
  const value: SerialNumberIdentityValue = {
    entityClassName: normalizeIdentityPart(entityClassName),
    tenantCode: normalizeIdentityPart(tenantCode)
  };
  const key = identityKey(
    [entityClassName, tenantCode],
    ["entityClassName", "tenantCode"]
  );
  if (identities.keys.has(key)) {
    throw new CliError(
      `给号配置业务唯一键 entityClassName+tenantCode 重复：entityClassName=${entityClassName}, tenantCode=${tenantCode}（匹配至少 2 条）`
    );
  }
  identities.keys.add(key);
  identities.values.push(value);
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

function resourceIdentityFields(spec: ResourceSpec): string[] {
  return spec.identityFields;
}

function identityValue(
  record: ResourceRecord,
  spec: ResourceSpec,
  overrides: Partial<Record<string, string>> = {}
): string {
  const fields = resourceIdentityFields(spec);
  const values = fields.map((field) =>
    requiredIdentityPart(
      overrides[field] ?? record[field],
      field,
      `资源 ${spec.name}`
    )
  );
  return values.length === 1 ? values[0]! : identityKey(values, fields);
}

function identityKey(values: string[], fields: string[] = []): string {
  const normalized = values.map(normalizeIdentityPart);
  if (normalized.length === 1) return normalized[0]!;
  const fieldNames = fields.length === normalized.length
    ? fields
    : normalized.map((_value, index) => String(index));
  return JSON.stringify(
    Object.fromEntries(fieldNames.map((field, index) => [field, normalized[index]!]))
  );
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function requiredIdentityPart(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`${label}缺少有效业务唯一键字段 ${field}`);
  }
  return value.trim();
}

function findByIdentity(
  records: ResourceRecord[],
  spec: ResourceSpec,
  value: string
): ResourceRecord | undefined {
  const fields = resourceIdentityFields(spec);
  const comparableValue = fields.length === 1
    ? identityKey([value], fields)
    : value;
  const matches = records.filter((record) => {
    try {
      const values = fields.map((field) =>
        requiredIdentityPart(record[field], field, `目标环境资源`)
      );
      return identityKey(values, fields) === comparableValue;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) {
    throw new CliError(`目标环境业务唯一键重复：${identityDescription(spec)}=${value}`);
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
  const counts = new Map<string, { values: string[]; count: number }>();
  for (const record of records) {
    const fields = resourceIdentityFields(spec);
    const values = fields.map((field) =>
      requiredIdentityPart(record[field], field, `${label}资源`)
    );
    const key = identityKey(values, fields);
    const current = counts.get(key);
    counts.set(key, { values, count: (current?.count ?? 0) + 1 });
  }
  const duplicate = [...counts.values()].find((item) => item.count > 1);
  if (duplicate) {
    throw new CliError(
      `${label}业务唯一键重复：${identityDescription(spec)}=${formatIdentityValues(
        resourceIdentityFields(spec),
        duplicate.values
      )}（匹配 ${duplicate.count} 条）`
    );
  }
}

function identityDescription(spec: ResourceSpec): string {
  return resourceIdentityFields(spec).join("+");
}

function formatIdentityValues(fields: string[], values: string[]): string {
  return fields.map((field, index) => `${field}=${values[index]}`).join(", ");
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
