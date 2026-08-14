import { CliError } from "../../errors.js";
import type { ResourceClient, ResourceFilter, ResourceRecord } from "../../resource/core/client.js";
import type { BlockingIssue, MissingDependency } from "../../resource/core/errors.js";
import type {
  ResourceApplyContext,
  ResourcePhaseHooks,
  ResourcePlanChange,
  ResourcePlanContext,
  ResourceVerifyContext
} from "../../resource/core/engine.js";

export interface MenuRecord extends ResourceRecord {
  code: string;
  name: string;
  parentCode: string | null;
}

export interface MenuChange {
  key: string;
  action: "create" | "update" | "unchanged" | "blocked";
  changedFields: string[];
  before: MenuRecord | null;
  desired: Record<string, unknown> | null;
  missingDependencies?: MissingDependency[];
  blockingIssues?: BlockingIssue[];
}

const logicalFields = ["name", "rank", "iconCls", "parentCode", "featureCode"];
export const MENU_CODE_MAX_LENGTH = 20;

export function assertMenuCodeLength(code: unknown): void {
  if (code === undefined) return;
  if (typeof code !== "string") throw new CliError("菜单 code 必须是字符串");
  const length = Array.from(code).length;
  if (length > MENU_CODE_MAX_LENGTH) {
    throw new CliError(`菜单 code 最多${MENU_CODE_MAX_LENGTH}个字符：${code}（当前${length}个字符）`);
  }
}

export async function loadMenus(client: ResourceClient): Promise<MenuRecord[]> {
  const result: MenuRecord[] = [];
  const visiting = new Set<ResourceRecord>();
  const visit = (node: ResourceRecord, parentCode: string | null): void => {
    if (visiting.has(node)) throw new CliError("菜单树存在循环引用");
    visiting.add(node);
    const code = requiredString(node.code, "菜单缺少有效 code");
    const name = requiredString(node.name, `菜单 ${code} 缺少有效 name`);
    const children = node.children;
    if (children !== undefined && (!Array.isArray(children) || !children.every(isRecord))) {
      throw new CliError(`菜单 ${code} 的 children 格式无效`);
    }
    const { children: _children, ...fields } = node;
    result.push({ ...fields, code, name, parentCode });
    for (const child of children ?? []) visit(child, code);
    visiting.delete(node);
  };
  for (const root of await client.getTree("menu")) visit(root, null);
  assertUniqueCodes(result, "环境");
  return result;
}

export function filterMenus(
  menus: MenuRecord[],
  filters: ResourceFilter[],
  quick?: string
): MenuRecord[] {
  const normalizedQuick = quick?.trim().toLocaleLowerCase();
  return menus.filter((menu) => {
    if (normalizedQuick && ![menu.code, menu.name, menu.namePath]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuick))) {
      return false;
    }
    return filters.every((filter) => matchFilter(menu[filter.fieldName], filter.operator, filter.value));
  });
}

export async function resolveFeatureId(
  client: ResourceClient,
  code: string
): Promise<{ id: string; code: string }> {
  const page = await client.findByPage("feature", {
    filters: [{ fieldName: "code", operator: "EQ", value: code }]
  });
  const matches = page.rows.filter((record) => sameText(record.code, code));
  if (matches.length !== 1) {
    throw new CliError(`功能项 code=${code} ${matches.length === 0 ? "不存在" : `不唯一（匹配 ${matches.length} 条）`}`);
  }
  return { id: requiredString(matches[0]!.id, `功能项 ${code} 缺少有效 ID`), code };
}

export function selectMenuByCode(menus: MenuRecord[], code: string, label = "菜单"): MenuRecord {
  const matches = menus.filter((menu) => sameText(menu.code, code));
  if (matches.length !== 1) {
    throw new CliError(`${label} code=${code} ${matches.length === 0 ? "不存在" : `不唯一（匹配 ${matches.length} 条）`}`);
  }
  return matches[0]!;
}

export function assertCanBeParent(menu: MenuRecord): void {
  if (nonBlank(menu.featureId) || nonBlank(menu.featureCode)) {
    throw new CliError(`菜单 ${menu.code} 已绑定功能项，不能作为父菜单`);
  }
}

/** Load hook: read the menu tree and flatten it into parentCode-bearing records. */
export function loadMenuRecords(client: ResourceClient): Promise<ResourceRecord[]> {
  return loadMenus(client);
}

/** Plan hook: classify each selected menu as create/update/unchanged/blocked. */
async function planMenuChanges(
  source: ResourceRecord[],
  target: ResourceRecord[],
  context: ResourcePlanContext
): Promise<ResourcePlanChange[]> {
  const code = context.selectors.code;
  assertMenuCodeLength(code);
  const allSource = source as MenuRecord[];
  const initialTarget = target as MenuRecord[];
  assertUniqueCodes(allSource, "源环境");
  assertUniqueCodes(initialTarget, "目标环境");
  const selected = selectSubtree(allSource, code);
  for (const menu of selected) assertMenuCodeLength(menu.code);
  const sourceByCode = codeMap(allSource);
  const targetByCode = codeMap(initialTarget);
  const featureCodes = [...new Set(selected.map(featureCode).filter((value): value is string => Boolean(value)))];
  const targetFeatures = featureCodes.length
    ? (await context.targetClient.findByPage("feature")).rows
    : [];
  const targetFeatureMap = uniqueDependencyMap(targetFeatures, "功能项");
  const changes: MenuChange[] = [];
  const statusByCode = new Map<string, MenuChange>();

  for (const sourceMenu of sortParentsFirst(selected, sourceByCode)) {
    const key = sourceMenu.code;
    const targetMenu = targetByCode.get(normalize(key));
    const dependencies: MissingDependency[] = [];
    const issues: BlockingIssue[] = [];
    const parentCode = sourceMenu.parentCode;
    if (parentCode) {
      const sourceParent = sourceByCode.get(normalize(parentCode));
      if (!sourceParent) {
        dependencies.push(menuDependency(parentCode, "missing"));
      } else {
        const parentChange = statusByCode.get(normalize(parentCode));
        const targetParent = targetByCode.get(normalize(parentCode));
        if (parentChange?.action === "blocked" || (!targetParent && !parentChange)) {
          dependencies.push(menuDependency(parentCode, "missing"));
        }
        if (nonBlank(sourceParent.featureId) || nonBlank(sourceParent.featureCode)) {
          issues.push({
            resource: "menu",
            field: "parentCode",
            reason: "invalid",
            message: `父菜单 ${parentCode} 已绑定功能项`
          });
        }
      }
    }
    const sourceFeatureCode = featureCode(sourceMenu);
    let mappedFeatureId: string | undefined;
    if (nonBlank(sourceMenu.featureId) && !sourceFeatureCode) {
      issues.push({
        resource: "menu",
        field: "featureCode",
        reason: "invalid",
        message: `菜单 ${key} 包含 featureId，但源接口未返回 featureCode`
      });
    } else if (sourceFeatureCode) {
      const matches = targetFeatureMap.get(normalize(sourceFeatureCode)) ?? [];
      if (matches.length !== 1) {
        dependencies.push({
          resource: "feature",
          identityField: "code",
          value: sourceFeatureCode,
          reason: matches.length === 0 ? "missing" : "ambiguous"
        });
      } else {
        mappedFeatureId = requiredString(matches[0]!.id, `目标功能项 ${sourceFeatureCode} 缺少有效 ID`);
      }
    }
    if (dependencies.length || issues.length) {
      const change: MenuChange = {
        key,
        action: "blocked",
        changedFields: [],
        before: targetMenu ?? null,
        desired: null,
        ...(dependencies.length ? { missingDependencies: dependencies } : {}),
        ...(issues.length ? { blockingIssues: issues } : {})
      };
      changes.push(change);
      statusByCode.set(normalize(key), change);
      continue;
    }
    const desired = logicalMenu(sourceMenu);
    if (mappedFeatureId) desired.featureId = mappedFeatureId;
    const changedFields = targetMenu ? logicalFields.filter(
      (field) => !sameValue(logicalMenu(targetMenu)[field], desired[field])
    ) : logicalFields.filter((field) => field in desired);
    const change: MenuChange = {
      key,
      action: targetMenu ? (changedFields.length ? "update" : "unchanged") : "create",
      changedFields,
      before: targetMenu ?? null,
      desired
    };
    changes.push(change);
    statusByCode.set(normalize(key), change);
  }
  return changes;
}

/**
 * Apply hook: write the writable changes through the generic engine's gate.
 * The target tree is re-read at the start so newly-created parents can resolve
 * their target IDs in parent-first order without threading plan-time state.
 */
async function applyMenuChanges(
  writable: ResourcePlanChange[],
  client: ResourceClient,
  context: ResourceApplyContext
): Promise<void> {
  const targetByCode = new Map<string, ResourceRecord>();
  for (const menu of await loadMenus(client)) targetByCode.set(normalize(menu.code), menu);
  for (const change of writable) {
    const desired = change.desired!;
    const parentCode = typeof desired.parentCode === "string" && desired.parentCode
      ? desired.parentCode
      : null;
    const current = targetByCode.get(normalize(change.key));
    const parent = parentCode ? targetByCode.get(normalize(parentCode)) : undefined;
    const payload = current
      ? withoutChildren({ ...current, name: desired.name, rank: desired.rank })
      : { code: desired.code, name: desired.name, rank: desired.rank };
    setOptional(payload, "iconCls", desired.iconCls);
    if (current) {
      payload.parentId = current.parentId;
    } else if (parentCode) {
      payload.parentId = requiredString(parent?.id, `目标父菜单 ${parentCode} 缺少有效 ID`);
    }
    const sourceFeatureCode = featureCode(desired);
    if (sourceFeatureCode) payload.featureId = desired.featureId;
    else if (current) payload.featureId = null;

    let saved: ResourceRecord | undefined = current;
    const saveFields = change.changedFields.filter((field) => field !== "parentCode");
    if (!current || saveFields.length) {
      saved = await client.save("menu", payload);
      if (!current) {
        await context.recorder!.recordAction({
          type: "create-entity",
          service: "sei-basic",
          resource: "menu",
          entityId: requiredString(saved!.id, `菜单 ${change.key} 保存后缺少 ID`),
          expected: rollbackExpected(payload),
          deleteMethod: "DELETE"
        });
      }
    }
    if (current && change.changedFields.includes("parentCode")) {
      await client.move(
        "menu",
        requiredString(current.id, `目标菜单 ${change.key} 缺少有效 ID`),
        parentCode
          ? requiredString(parent?.id, `目标父菜单 ${parentCode} 缺少有效 ID`)
          : ""
      );
    }
    targetByCode.set(normalize(change.key), {
      ...desired,
      ...saved,
      parentCode,
      featureCode: sourceFeatureCode
    });
  }
}

/** Verify hook: re-read the target tree and compare the logical menu fields. */
async function verifyMenuChanges(
  client: ResourceClient,
  context: ResourceVerifyContext
): Promise<boolean> {
  const after = codeMap(await loadMenus(client));
  return context.plan.changes
    .filter((change) => change.action !== "blocked")
    .every((change) => {
      const actual = after.get(normalize(change.key));
      return actual !== undefined && logicalFields.every(
        (field) => sameValue(logicalMenu(actual)[field], change.desired![field])
      );
    });
}

/** Menu extends every phase of the generic engine; the engine owns the envelope. */
export const menuPhaseHooks: ResourcePhaseHooks = {
  load: loadMenuRecords,
  plan: planMenuChanges,
  apply: applyMenuChanges,
  verify: verifyMenuChanges
};

export function logicalMenu(menu: ResourceRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {
    code: menu.code,
    name: menu.name,
    rank: typeof menu.rank === "number" ? menu.rank : 0,
    parentCode: typeof menu.parentCode === "string" && menu.parentCode ? menu.parentCode : null,
    featureCode: featureCode(menu) ?? null,
    iconCls: menu.iconCls ?? null
  };
  return result;
}

function selectSubtree(menus: MenuRecord[], code?: string): MenuRecord[] {
  if (!code) return menus;
  const root = selectMenuByCode(menus, code, "源菜单");
  const selected = new Set<string>([normalize(root.code)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const menu of menus) {
      if (menu.parentCode && selected.has(normalize(menu.parentCode)) && !selected.has(normalize(menu.code))) {
        selected.add(normalize(menu.code));
        changed = true;
      }
    }
  }
  return menus.filter((menu) => selected.has(normalize(menu.code)));
}

function sortParentsFirst(menus: MenuRecord[], all: Map<string, MenuRecord>): MenuRecord[] {
  const depth = (menu: MenuRecord): number => {
    let value = 0;
    let parent = menu.parentCode;
    const seen = new Set<string>([normalize(menu.code)]);
    while (parent) {
      const key = normalize(parent);
      if (seen.has(key)) throw new CliError(`菜单 ${menu.code} 的父节点关系存在循环`);
      seen.add(key);
      value++;
      parent = all.get(key)?.parentCode ?? null;
    }
    return value;
  };
  return [...menus].sort((left, right) => depth(left) - depth(right));
}

function uniqueDependencyMap(records: ResourceRecord[], label: string): Map<string, ResourceRecord[]> {
  const result = new Map<string, ResourceRecord[]>();
  for (const record of records) {
    if (typeof record.code !== "string" || !record.code) throw new CliError(`${label}缺少有效 code`);
    const key = normalize(record.code);
    result.set(key, [...(result.get(key) ?? []), record]);
  }
  return result;
}

function codeMap(records: MenuRecord[]): Map<string, MenuRecord> {
  assertUniqueCodes(records, "菜单");
  return new Map(records.map((record) => [normalize(record.code), record]));
}

function assertUniqueCodes(records: MenuRecord[], label: string): void {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(normalize(record.code), (counts.get(normalize(record.code)) ?? 0) + 1);
  const duplicate = records.find((record) => (counts.get(normalize(record.code)) ?? 0) > 1);
  if (duplicate) throw new CliError(`${label}菜单 code=${duplicate.code} 不唯一`);
}

function featureCode(menu: ResourceRecord): string | undefined {
  return typeof menu.featureCode === "string" && menu.featureCode.trim() ? menu.featureCode.trim() : undefined;
}

function menuDependency(code: string, reason: "missing" | "ambiguous"): MissingDependency {
  return { resource: "menu", identityField: "code", value: code, reason };
}

function rollbackExpected(payload: ResourceRecord): ResourceRecord {
  const expected: ResourceRecord = {};
  for (const field of ["code", "name", "rank", "parentId", "featureId", "iconCls"]) {
    if (field in payload) expected[field] = payload[field];
  }
  return expected;
}

function withoutChildren(record: ResourceRecord): ResourceRecord {
  const { children: _children, parentCode: _parentCode, featureCode: _featureCode, ...result } = record;
  return result;
}

function setOptional(record: ResourceRecord, field: string, value: unknown): void {
  if (value !== undefined) record[field] = value;
}

function matchFilter(left: unknown, operator: string, right: unknown): boolean {
  switch (operator.toUpperCase()) {
    case "EQ": return sameValue(left, right);
    case "NE": return !sameValue(left, right);
    case "LIKE": return String(left ?? "").toLocaleLowerCase().includes(String(right ?? "").toLocaleLowerCase());
    case "GT": return String(left ?? "") > String(right ?? "");
    case "GE": return String(left ?? "") >= String(right ?? "");
    case "LT": return String(left ?? "") < String(right ?? "");
    case "LE": return String(left ?? "") <= String(right ?? "");
    default: throw new CliError(`菜单查询不支持过滤操作符 ${operator}`);
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CliError(message);
  return value.trim();
}
function nonBlank(value: unknown): boolean { return typeof value === "string" && Boolean(value.trim()); }
function normalize(value: string): string { return value.trim().toLocaleLowerCase(); }
function sameText(left: unknown, right: string): boolean { return typeof left === "string" && normalize(left) === normalize(right); }
function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
function isRecord(value: unknown): value is ResourceRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
