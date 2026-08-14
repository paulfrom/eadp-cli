import type { Command } from "commander";
import { resolveEnvironment, type ResolvedEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { getRuntimeOptions, type RuntimeOptions } from "../runtime-options.js";
import { printValue } from "../io.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import { createResourceClient, type ResourceClient, type ResourceRecord } from "../resource/core/client.js";
import {
  assertCanBeParent,
  loadMenus,
  logicalMenu,
  resolveFeatureId,
  selectMenuByCode,
  assertMenuCodeLength
} from "../domains/menu/service.js";
import { assertPathTenantScope } from "../tenant.js";

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

export function registerMenuCommands(root: Command, store: ConfigStore): void {
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


function createClient(
  environment: ResolvedEnvironment,
  service: string,
  timeoutMs: number
): ResourceClient {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service,
    timeoutMs
  });
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
