import { Command } from "commander";
import { resolveEnvironment } from "../../config/resolve.js";
import { ConfigStore } from "../../config/store.js";
import { CliError } from "../../errors.js";
import { printValue } from "../../io.js";
import { OperationRecorder } from "../../operations/recorder.js";
import { OperationLogStore } from "../../operations/store.js";
import { inferProjectModuleName } from "../../project/name.js";
import { getRuntimeOptions } from "../../runtime-options.js";
import { assertTenantScope } from "../../tenant.js";
import { PermissionClient, type PermissionRecord } from "./client.js";
import type {
  ApplyFeatureGroupOptions,
  ApplyFeatureOptions,
  AssignPermissionOptions,
  AssignPrincipalOptions,
  CommonOptions,
  NewOperationAction,
  VerifyOptions
} from "./options.js";

export async function applyFeature(
  store: ConfigStore,
  options: ApplyFeatureOptions,
  root: Command
): Promise<void> {
  const context = await createGlobalContext(store, options, root);
  const code = options.code.trim();
  const name = options.name.trim();
  if (!code) {
    throw new CliError("功能项代码不能为空");
  }
  if (!name) {
    throw new CliError("功能项名称不能为空");
  }
  if (!options.app.trim()) {
    throw new CliError("应用模块选择器不能为空");
  }
  if (
    options.featureType === "Page" &&
    (typeof options.url !== "string" || options.url.trim() === "")
  ) {
    throw new CliError("Page 类型功能项必须显式提供非空 --url");
  }

  const existing = await context.client.findFeatureByCode(code);
  if (existing) {
    printValue(
      {
        kind: "eadp.permission.feature.apply.v1",
        environment: context.environment,
        applied: false,
        action: "unchanged",
        appModule: null,
        featureGroup: null,
        before: existing,
        desired: null,
        verified: true
      },
      options.compact
    );
    return;
  }

  const [appModules, featureGroups] = await Promise.all([
    context.client.findAll("appModule"),
    options.group
      ? context.client.findAll("featureGroup")
      : Promise.resolve([] as PermissionRecord[])
  ]);
  const appModule = selectRecord(appModules, options.app, "应用模块");
  const appModuleId = recordId(appModule, "应用模块");
  const featureGroup = options.group
    ? selectRecord(featureGroups, options.group, "功能项组")
    : undefined;
  if (featureGroup) {
    assertFeatureGroupAppModule(featureGroup, appModule, appModuleId);
  }

  // 默认约定：Page/Business 的 --url 映射到 groupCode，Operate 忽略 --url。
  const normalizedUrl =
    options.url === undefined ? undefined : normalizeFeatureUrl(options.url);
  const desired = normalizeFeatureDesired({
    code,
    name,
    featureType: options.featureType,
    appModuleId,
    canMenu: options.canMenu ?? options.featureType !== "Operate",
    tenantCanUse: options.tenantCanUse !== false,
    mobileUse: options.mobileUse === true,
    ...(featureGroup
      ? { featureGroupId: recordId(featureGroup, "功能项组") }
      : {}),
    ...(normalizedUrl !== undefined && options.featureType !== "Operate"
      ? { groupCode: normalizedUrl }
      : {})
  });
  if (!options.apply) {
    printValue(
      {
        kind: "eadp.permission.feature.apply.v1",
        environment: context.environment,
        applied: false,
        action: "create",
        appModule,
        featureGroup: featureGroup ?? null,
        before: null,
        desired,
        verified: false
      },
      options.compact
    );
    return;
  }

  const saved = await context.client.save("feature", desired);
  const operationId = await recordOperation(store, context.environment, "eadp permission apply feature", {
    type: "create-entity",
    service: "sei-basic",
    resource: "feature",
    entityId: recordId(saved, "功能项"),
    expected: desired,
    deleteMethod: "DELETE"
  });
  const verifiedFeature = await context.client.findFeatureByCode(code);
  const verified =
    verifiedFeature !== null &&
    changedFeatureFields(verifiedFeature, desired).length === 0;
  if (!verified) {
    throw new CliError(`功能项创建后回查验证失败：${code}`);
  }
  printValue(
    {
      kind: "eadp.permission.feature.apply.v1",
      environment: context.environment,
      applied: true,
      action: "create",
      appModule,
      featureGroup: featureGroup ?? null,
      before: null,
      desired,
      saved,
      operationId,
      verified,
      verifiedFeature
    },
    options.compact
  );
}

export async function applyFeatureGroup(
  store: ConfigStore,
  options: ApplyFeatureGroupOptions,
  root: Command
): Promise<void> {
  const context = await createGlobalContext(store, options, root);
  const code = options.code.trim();
  const name = options.name.trim();
  const appCode = options.appCode.trim();
  if (!code) throw new CliError("功能项组代码不能为空");
  if (!name) throw new CliError("功能项组名称不能为空");
  if (!appCode) throw new CliError("应用模块 code 不能为空");

  // This is intentionally the first and only lookup on the unchanged path.
  // It prevents an existing group from causing any app-module read or write.
  const existingGroup = await context.client.findFeatureGroupByCode(code);
  if (existingGroup) {
    printValue(
      {
        kind: "eadp.permission.feature-group.apply.v1",
        environment: context.environment,
        applied: false,
        action: "unchanged",
        appModuleAction: "skipped",
        featureGroupAction: "unchanged",
        appModule: null,
        featureGroup: {
          action: "unchanged",
          ...existingGroup,
          before: existingGroup,
          desired: null
        },
        before: existingGroup,
        desired: null,
        verified: true
      },
      options.compact
    );
    return;
  }

  const appModules = await context.client.findAppModulesByCode(appCode);
  if (appModules.length > 1) {
    throw new CliError(`应用模块 code 不唯一：${appCode}（匹配 ${appModules.length} 条）`);
  }
  const appModule = appModules[0];
  // Existing modules are immutable for this command.  Do not inspect the
  // project path in that case: the remote module already supplies its name
  // and rank, and an unrelated/unreadable project must not block reuse.
  const inferred = appModule
    ? undefined
    : await inferProjectModuleName(options.project ?? process.cwd());
  const moduleName = inferred?.name ?? (typeof appModule?.name === "string" ? appModule.name : "");
  const moduleRank = appModule?.rank ?? options.rank;
  const moduleDesired: PermissionRecord = {
    code: appCode,
    name: moduleName,
    rank: moduleRank
  };
  const appModuleId = appModule ? recordId(appModule, "应用模块") : undefined;
  const moduleAction = appModule ? "unchanged" : "create";
  const groupDesiredPreview: PermissionRecord = {
    code,
    name,
    appModuleId: appModuleId ?? null
  };

  if (!options.apply) {
    printValue(
      {
        kind: "eadp.permission.feature-group.apply.v1",
        environment: context.environment,
        applied: false,
        action: "create",
        appModuleAction: moduleAction,
        featureGroupAction: "create",
        appModule: {
          action: moduleAction,
          code: appCode,
          name: moduleName,
          rank: moduleRank,
          before: appModule ?? null,
          desired: moduleDesired,
          ...(inferred
            ? { inference: { source: inferred.source, projectPath: inferred.projectPath } }
            : { inference: { source: "remote" as const } })
        },
        featureGroup: {
          action: "create",
          before: null,
          desired: groupDesiredPreview
        },
        before: null,
        desired: groupDesiredPreview,
        verified: false
      },
      options.compact
    );
    return;
  }

  const recorder = new OperationRecorder(
    new OperationLogStore(store.directory),
    "eadp permission apply feature-group",
    context.environment
  );
  try {
    let targetAppModule = appModule;
    if (!targetAppModule) {
      const savedModule = await context.client.save("appModule", moduleDesired);
      await recorder.recordAction({
        type: "create-entity",
        service: "sei-basic",
        resource: "appModule",
        entityId: recordId(savedModule, "应用模块"),
        expected: moduleDesired,
        deleteMethod: "DELETE"
      });
      const verifiedModules = await context.client.findAppModulesByCode(appCode);
      if (verifiedModules.length > 1) {
        throw new CliError(`应用模块创建后 code 不唯一：${appCode}`);
      }
      targetAppModule = verifiedModules[0];
      if (!targetAppModule || !sameFields(targetAppModule, moduleDesired, ["code", "name", "rank"])) {
        throw new CliError(`应用模块创建后回查验证失败：${appCode}`);
      }
    }
    const targetAppModuleId = recordId(targetAppModule, "应用模块");
    const groupDesired: PermissionRecord = {
      code,
      name,
      appModuleId: targetAppModuleId
    };
    const savedGroup = await context.client.save("featureGroup", groupDesired);
    await recorder.recordAction({
      type: "create-entity",
      service: "sei-basic",
      resource: "featureGroup",
      entityId: recordId(savedGroup, "功能项组"),
      expected: groupDesired,
      deleteMethod: "DELETE"
    });
    const verifiedGroup = await context.client.findFeatureGroupByCode(code);
    if (!verifiedGroup || !sameFields(verifiedGroup, groupDesired, ["code", "name", "appModuleId"])) {
      throw new CliError(`功能项组创建后回查验证失败：${code}`);
    }
    const operationId = await recorder.complete();
    printValue(
      {
        kind: "eadp.permission.feature-group.apply.v1",
        environment: context.environment,
        applied: true,
        action: "create",
        appModuleAction: moduleAction,
        featureGroupAction: "create",
        appModule: {
          action: moduleAction,
          code: appCode,
          name: moduleName,
          rank: moduleRank,
          before: appModule ?? null,
          desired: moduleDesired,
          actual: targetAppModule,
          ...(inferred
            ? { inference: { source: inferred.source, projectPath: inferred.projectPath } }
            : { inference: { source: "remote" as const } })
        },
        featureGroup: {
          action: "create",
          before: null,
          desired: groupDesired,
          actual: verifiedGroup
        },
        before: null,
        desired: groupDesired,
        saved: savedGroup,
        ...(operationId ? { operationId } : {}),
        verified: true,
        verifiedFeatureGroup: verifiedGroup
      },
      options.compact
    );
  } catch (error) {
    await recorder.fail(error);
    const suffix = recorder.hasActions
      ? `；可使用 operation-id ${recorder.operationId} 回滚已新增的功能项组和应用模块`
      : "";
    throw new CliError(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}

export function sameFields(
  record: PermissionRecord,
  expected: PermissionRecord,
  fields: string[]
): boolean {
  return fields.every((field) => {
    const left = record[field];
    const right = expected[field];
    if (field === "rank") {
      return Number(left) === Number(right);
    }
    return left === right;
  });
}

export async function createContext(
  store: ConfigStore,
  options: CommonOptions,
  root: Command
): Promise<{
  environment: string;
  tenantCode: string;
  client: PermissionClient;
}> {
  const runtime = getRuntimeOptions(root);
  options.compact = runtime.compact;
  const resolved = resolveEnvironment(await store.load(), options.env);
  assertTenantScope(resolved.config.tenantCode, "non-global", resolved.name);
  return {
    environment: resolved.name,
    tenantCode: resolved.config.tenantCode!,
    client: new PermissionClient({
      baseUrl: resolved.config.baseUrl,
      token: resolved.token,
      authorization: resolved.authorization,
      timeoutMs: runtime.timeoutMs
    })
  };
}

export async function createGlobalContext(
  store: ConfigStore,
  options: CommonOptions,
  root: Command
): Promise<{
  environment: string;
  tenantCode: string;
  client: PermissionClient;
}> {
  const runtime = getRuntimeOptions(root);
  options.compact = runtime.compact;
  const resolved = resolveEnvironment(await store.load(), options.env);
  assertTenantScope(resolved.config.tenantCode, "global", resolved.name);
  return {
    environment: resolved.name,
    tenantCode: resolved.config.tenantCode!,
    client: new PermissionClient({
      baseUrl: resolved.config.baseUrl,
      token: resolved.token,
      authorization: resolved.authorization,
      timeoutMs: runtime.timeoutMs
    })
  };
}

export type PermissionCopyCategory = "functionalRoles" | "dataRoles" | "positions";

export interface PermissionCopyDiff {
  category: PermissionCopyCategory;
  resource: "userFeatureRole" | "userDataRole" | "employeePosition";
  source: PermissionRecord[];
  eligible: PermissionRecord[];
  skippedPublic: PermissionRecord[];
  alreadyAssigned: PermissionRecord[];
  added: PermissionRecord[];
}

export interface PermissionCopyRelations {
  functionalRoles: PermissionRecord[];
  dataRoles: PermissionRecord[];
  positions: PermissionRecord[];
}

export async function assignPermission(
  store: ConfigStore,
  options: AssignPermissionOptions,
  root: Command
): Promise<void> {
  const context = await createContext(store, options, root);
  const source = await resolvePermissionEmployee(context.client, {
    ...(options.sourceEmployeeCode === undefined
      ? {}
      : { employeeCode: options.sourceEmployeeCode }),
    ...(options.sourceEmployeeName === undefined
      ? {}
      : { employeeName: options.sourceEmployeeName }),
    label: "源员工"
  });
  const target = await resolvePermissionEmployee(context.client, {
    ...(options.targetEmployeeCode === undefined
      ? {}
      : { employeeCode: options.targetEmployeeCode }),
    ...(options.targetEmployeeName === undefined
      ? {}
      : { employeeName: options.targetEmployeeName }),
    label: "目标员工"
  });
  const sourceId = recordId(source, "源员工");
  const targetId = recordId(target, "目标员工");
  if (
    sourceId === targetId ||
    (typeof source.code === "string" &&
      typeof target.code === "string" &&
      source.code.trim().toLocaleLowerCase() ===
        target.code.trim().toLocaleLowerCase())
  ) {
    throw new CliError("源员工和目标员工不能相同");
  }
  assertPermissionEmployeeTenant(source, context.tenantCode, "源员工");
  assertPermissionEmployeeTenant(target, context.tenantCode, "目标员工");

  const sourceRelations = await readPermissionRelations(context.client, sourceId);
  const targetRelations = await readPermissionRelations(context.client, targetId);
  const diffs = buildPermissionCopyDiffs(sourceRelations, targetRelations);
  const requested = toPermissionCopyRelations(diffs, "source");
  const skippedPublic = toPermissionCopyRelations(diffs, "skippedPublic");
  const alreadyAssigned = toPermissionCopyRelations(diffs, "alreadyAssigned");
  const added = toPermissionCopyRelations(diffs, "added");
  const counts = buildPermissionCopyCounts(diffs);
  const hasChanges = diffs.some((diff) => diff.added.length > 0);

  let recorder: OperationRecorder | undefined;
  let operationId: string | undefined;
  try {
    if (options.apply && hasChanges) {
      recorder = new OperationRecorder(
        new OperationLogStore(store.directory),
        "eadp permission assign permission",
        context.environment
      );
      for (const diff of diffs) {
        if (diff.added.length === 0) continue;
        const addedIds = diff.added.map(permissionRelationId);
        await context.client.insertRelations(diff.resource, targetId, addedIds);
        await recorder.recordAction({
          type: "assign-relations",
          service: "sei-basic",
          resource: diff.resource,
          parentId: targetId,
          childIds: addedIds
        });
      }
    }

    let verified = false;
    if (options.apply) {
      const verifiedRelations = await readPermissionRelations(context.client, targetId);
      verified = verifyPermissionCopy(diffs, verifiedRelations);
      if (!verified) {
        throw new CliError("权限关系写入后回查失败");
      }
      if (recorder) {
        operationId = await recorder.complete();
      }
    }

    printValue(
      {
        kind: "eadp.permission.copy.v1",
        environment: context.environment,
        applied: options.apply === true && hasChanges,
        action: hasChanges ? (options.apply ? "assigned" : "preview") : "unchanged",
        source,
        sourceDirect: requested,
        target,
        requested,
        skippedPublic,
        alreadyAssigned,
        added,
        counts,
        ...(operationId ? { operationId } : {}),
        verified
      },
      options.compact
    );
  } catch (error) {
    if (recorder) {
      await recorder.fail(error);
    }
    const suffix = recorder?.hasActions
      ? `；部分关系可能已新增，可使用 operation-id ${recorder.operationId} 回滚`
      : "";
    throw new CliError(
      `${error instanceof Error ? error.message : String(error)}${suffix}`
    );
  }
}

export async function resolvePermissionEmployee(
  client: PermissionClient,
  selector: {
    employeeCode?: string;
    employeeName?: string;
    label: string;
  }
): Promise<PermissionRecord> {
  const selectorCount =
    (selector.employeeCode ? 1 : 0) + (selector.employeeName ? 1 : 0);
  if (selectorCount !== 1) {
    throw new CliError(
      `${selector.label}必须且只能提供 --${selector.label === "源员工" ? "source" : "target"}-employee-code 或 --${selector.label === "源员工" ? "source" : "target"}-employee-name`
    );
  }
  if (selector.employeeCode) {
    const employee = await client.findEmployeeByCode(selector.employeeCode);
    if (!employee) {
      throw new CliError(`${selector.label}号不存在：${selector.employeeCode}`);
    }
    return employee;
  }
  const name = selector.employeeName!;
  const normalized = name.trim().toLocaleLowerCase();
  const matches = (await client.quickSearchEmployees(name)).filter((employee) => {
    const employeeName =
      typeof employee.userName === "string"
        ? employee.userName
        : typeof employee.name === "string"
          ? employee.name
          : undefined;
    return employeeName?.trim().toLocaleLowerCase() === normalized;
  });
  if (matches.length === 0) {
    throw new CliError(`${selector.label}姓名不存在：${name}`);
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((employee) => `${String(employee.code ?? "?")}/${String(employee.userAccount ?? "?")}`)
      .join(", ");
    throw new CliError(
      `${selector.label}姓名存在重名，请改用员工号：${name}（${candidates}）`
    );
  }
  return matches[0]!;
}

export function assertPermissionEmployeeTenant(
  employee: PermissionRecord,
  tenantCode: string,
  label: string
): void {
  if (typeof employee.tenantCode === "string" && employee.tenantCode !== tenantCode) {
    throw new CliError(`${label}不属于当前环境租户：${employee.tenantCode}`);
  }
}

export async function readPermissionRelations(
  client: PermissionClient,
  employeeId: string
): Promise<PermissionCopyRelations> {
  return {
    functionalRoles: await client.getChildren("userFeatureRole", employeeId),
    dataRoles: await client.getChildren("userDataRole", employeeId),
    positions: await client.getChildren("employeePosition", employeeId)
  };
}

export function buildPermissionCopyDiffs(
  source: PermissionCopyRelations,
  target: PermissionCopyRelations
): PermissionCopyDiff[] {
  return [
    createPermissionCopyDiff(
      "functionalRoles",
      "userFeatureRole",
      source.functionalRoles,
      target.functionalRoles,
      true
    ),
    createPermissionCopyDiff(
      "dataRoles",
      "userDataRole",
      source.dataRoles,
      target.dataRoles,
      true
    ),
    createPermissionCopyDiff(
      "positions",
      "employeePosition",
      source.positions,
      target.positions,
      false
    )
  ];
}

export function createPermissionCopyDiff(
  category: PermissionCopyCategory,
  resource: PermissionCopyDiff["resource"],
  source: PermissionRecord[],
  target: PermissionRecord[],
  skipPublic: boolean
): PermissionCopyDiff {
  const seenSourceIds = new Set<string>();
  const uniqueSource = source.filter((record) => {
    const id = permissionRelationId(record);
    if (seenSourceIds.has(id)) return false;
    seenSourceIds.add(id);
    return true;
  });
  const skippedPublic = skipPublic
    ? uniqueSource.filter(isPublicPermissionRole)
    : [];
  const eligible = uniqueSource.filter((record) => !skippedPublic.includes(record));
  const targetIds = new Set(target.map((record) => permissionRelationId(record)));
  const alreadyAssigned = eligible.filter((record) =>
    targetIds.has(permissionRelationId(record))
  );
  const alreadyIds = new Set(alreadyAssigned.map((record) => permissionRelationId(record)));
  const added = eligible.filter((record) => !alreadyIds.has(permissionRelationId(record)));
  return { category, resource, source: uniqueSource, eligible, skippedPublic, alreadyAssigned, added };
}

export function isPublicPermissionRole(record: PermissionRecord): boolean {
  return record.publicUserType !== null && record.publicUserType !== undefined;
}

export function permissionRelationId(record: PermissionRecord): string {
  if (typeof record.id === "string" && record.id) return record.id;
  if (typeof record.childId === "string" && record.childId) return record.childId;
  if (isPermissionRecord(record.child) && typeof record.child.id === "string" && record.child.id) {
    return record.child.id;
  }
  throw new CliError("权限关系缺少有效子实体 ID");
}

export function toPermissionCopyRelations(
  diffs: PermissionCopyDiff[],
  field: "source" | "skippedPublic" | "alreadyAssigned" | "added"
): PermissionCopyRelations {
  return {
    functionalRoles: diffs.find((diff) => diff.category === "functionalRoles")![field],
    dataRoles: diffs.find((diff) => diff.category === "dataRoles")![field],
    positions: diffs.find((diff) => diff.category === "positions")![field]
  };
}

export function buildPermissionCopyCounts(
  diffs: PermissionCopyDiff[]
): Record<PermissionCopyCategory, {
  requested: number;
  eligible: number;
  skippedPublic: number;
  alreadyAssigned: number;
  added: number;
}> {
  return Object.fromEntries(
    diffs.map((diff) => [
      diff.category,
      {
        requested: diff.source.length,
        eligible: diff.eligible.length,
        skippedPublic: diff.skippedPublic.length,
        alreadyAssigned: diff.alreadyAssigned.length,
        added: diff.added.length
      }
    ])
  ) as Record<PermissionCopyCategory, {
    requested: number;
    eligible: number;
    skippedPublic: number;
    alreadyAssigned: number;
    added: number;
  }>;
}

export function verifyPermissionCopy(
  diffs: PermissionCopyDiff[],
  target: PermissionCopyRelations
): boolean {
  const targetByCategory: Record<PermissionCopyCategory, PermissionRecord[]> = target;
  return diffs.every((diff) => {
    const targetIds = new Set(
      targetByCategory[diff.category].map((record) => permissionRelationId(record))
    );
    return diff.eligible.every((record) => targetIds.has(permissionRelationId(record)));
  });
}

export function selectFeatureByCode(
  features: PermissionRecord[],
  code: string
): PermissionRecord {
  const normalized = code.trim().toLocaleLowerCase();
  const matches = features.filter(
    (feature) =>
      typeof feature.code === "string" &&
      feature.code.trim().toLocaleLowerCase() === normalized
  );
  if (matches.length === 0) {
    throw new CliError(`功能项代码不存在：${code}`);
  }
  if (matches.length > 1) {
    throw new CliError(`功能项代码不唯一：${code}`);
  }
  return matches[0]!;
}

export function selectRecord(
  records: PermissionRecord[],
  selector: string,
  label: string
): PermissionRecord {
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = records.filter((record) =>
    ["id", "code", "name", "account", "userAccount", "userName"].some(
      (key) =>
        typeof record[key] === "string" &&
        record[key].trim().toLocaleLowerCase() === normalized
    )
  );
  if (matches.length === 0) {
    throw new CliError(`${label}不存在：${selector}`);
  }
  if (matches.length > 1) {
    throw new CliError(`${label}匹配到多条记录，请改用唯一 ID：${selector}`);
  }
  return matches[0]!;
}

export async function resolvePrincipalSubject(
  client: PermissionClient,
  options: AssignPrincipalOptions,
  subjectResource: string
): Promise<PermissionRecord> {
  const employeeSelectorCount = [
    options.employeeCode,
    options.employeeName
  ].filter(Boolean).length;
  if (options.subjectType !== "user") {
    if (employeeSelectorCount > 0) {
      throw new CliError("--employee-code 和 --employee-name 只适用于 user 主体");
    }
    if (!options.subject) {
      throw new CliError("岗位或岗位类别主体必须提供 --subject");
    }
    const subjects =
      options.subjectType === "position-category"
        ? await client.findAll(subjectResource)
        : await client.findByPage(subjectResource);
    return selectRecord(subjects, options.subject, "授权主体");
  }

  const selectorCount =
    (options.subject ? 1 : 0) +
    (options.employeeCode ? 1 : 0) +
    (options.employeeName ? 1 : 0);
  if (selectorCount !== 1) {
    throw new CliError(
      "用户主体必须且只能提供 --subject、--employee-code、--employee-name 之一"
    );
  }
  if (options.employeeCode || options.employeeName) {
    return resolveEmployee(client, {
      ...(options.employeeCode === undefined
        ? {}
        : { employeeCode: options.employeeCode }),
      ...(options.employeeName === undefined
        ? {}
        : { employeeName: options.employeeName })
    });
  }
  return selectRecord(
    await client.findByPage(subjectResource),
    options.subject!,
    "授权主体"
  );
}

export async function resolveVerifyUser(
  client: PermissionClient,
  options: VerifyOptions
): Promise<{
  account: string;
  userId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
}> {
  const selectorCount =
    (options.user ? 1 : 0) +
    (options.employeeCode ? 1 : 0) +
    (options.employeeName ? 1 : 0);
  if (selectorCount !== 1) {
    throw new CliError(
      "必须且只能提供 --user、--employee-code、--employee-name 之一"
    );
  }
  if (options.user) {
    return {
      account: options.user,
      userId: options.userId ?? null,
      employeeCode: null,
      employeeName: null
    };
  }
  if (options.userId) {
    throw new CliError("按员工号或姓名查询时会自动解析用户 ID，不应再提供 --user-id");
  }
  const employee = await resolveEmployee(client, {
    ...(options.employeeCode === undefined
      ? {}
      : { employeeCode: options.employeeCode }),
    ...(options.employeeName === undefined
      ? {}
      : { employeeName: options.employeeName })
  });
  const account = stringField(employee, "userAccount", "员工缺少 userAccount");
  return {
    account,
    userId: stringField(employee, "id", "员工缺少用户 ID"),
    employeeCode:
      typeof employee.code === "string" ? employee.code : null,
    employeeName:
      typeof employee.userName === "string" ? employee.userName : null
  };
}

export async function resolveEmployee(
  client: PermissionClient,
  selector: { employeeCode?: string; employeeName?: string }
): Promise<PermissionRecord> {
  if (selector.employeeCode) {
    const employee = await client.findEmployeeByCode(selector.employeeCode);
    if (!employee) {
      throw new CliError(`员工号不存在：${selector.employeeCode}`);
    }
    return employee;
  }
  if (!selector.employeeName) {
    throw new CliError("缺少员工号或员工姓名");
  }
  const normalized = selector.employeeName.trim().toLocaleLowerCase();
  const matches = (await client.quickSearchEmployees(selector.employeeName)).filter(
    (employee) =>
      typeof employee.userName === "string" &&
      employee.userName.trim().toLocaleLowerCase() === normalized
  );
  if (matches.length === 0) {
    throw new CliError(`员工姓名不存在：${selector.employeeName}`);
  }
  if (matches.length > 1) {
    const candidates = matches
      .map(
        (employee) =>
          `${String(employee.code ?? "?")}/${String(employee.userAccount ?? "?")}`
      )
      .join(", ");
    throw new CliError(
      `员工姓名存在重名，请改用员工号：${selector.employeeName}（${candidates}）`
    );
  }
  return matches[0]!;
}

export function stringField(
  record: PermissionRecord,
  field: string,
  message: string
): string {
  const value = record[field];
  if (typeof value !== "string" || !value) {
    throw new CliError(message);
  }
  return value;
}

export async function checkUserMenus(
  client: PermissionClient,
  userId: string,
  selectors: string[]
): Promise<
  Array<{
    selector: string;
    menu: PermissionRecord;
    featureCodes: string[];
    featureChecks: Record<string, boolean>;
    authorized: boolean;
  }>
> {
  const menuTree = await client.getMenuTree();
  const allMenus = flattenMenuTree(menuTree);
  const requested = selectors.map((selector) => {
    const menu = selectMenu(allMenus, selector);
    return {
      selector,
      menu,
      featureCodes: collectMenuFeatureCodes(menu)
    };
  });
  const featureCodes = [
    ...new Set(requested.flatMap((item) => item.featureCodes))
  ];
  const checks =
    featureCodes.length > 0
      ? await client.checkUserFeatures(userId, featureCodes)
      : {};
  return requested.map((item) => {
    const featureChecks = Object.fromEntries(
      item.featureCodes.map((code) => [code, checks[code] === true])
    );
    return {
      ...item,
      featureChecks,
      authorized: Object.values(featureChecks).some(Boolean)
    };
  });
}

export function flattenMenuTree(menus: PermissionRecord[]): PermissionRecord[] {
  const result: PermissionRecord[] = [];
  const visit = (menu: PermissionRecord): void => {
    result.push(menu);
    if (Array.isArray(menu.children)) {
      for (const child of menu.children) {
        if (isPermissionRecord(child)) {
          visit(child);
        }
      }
    }
  };
  menus.forEach(visit);
  return result;
}

export function selectMenu(
  menus: PermissionRecord[],
  selector: string
): PermissionRecord {
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = menus.filter((menu) =>
    ["id", "code", "name", "codePath", "namePath"].some((field) => {
      const value = menu[field];
      return (
        typeof value === "string" &&
        value.trim().toLocaleLowerCase() === normalized
      );
    })
  );
  if (matches.length === 0) {
    throw new CliError(`菜单不存在：${selector}`);
  }
  if (matches.length > 1) {
    const candidates = matches
      .map(
        (menu) =>
          `${String(menu.code ?? menu.id ?? "?")}/${String(
            menu.namePath ?? menu.name ?? "?"
          )}`
      )
      .join(", ");
    throw new CliError(
      `菜单匹配到多条记录，请改用菜单代码或路径：${selector}（${candidates}）`
    );
  }
  return matches[0]!;
}

export function collectMenuFeatureCodes(menu: PermissionRecord): string[] {
  const result = new Set<string>();
  const visit = (node: PermissionRecord): void => {
    if (typeof node.featureCode === "string" && node.featureCode) {
      result.add(node.featureCode);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (isPermissionRecord(child)) {
          visit(child);
        }
      }
    }
  };
  visit(menu);
  return [...result];
}

export function isPermissionRecord(value: unknown): value is PermissionRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordId(record: PermissionRecord, label: string): string {
  if (typeof record.id !== "string" || !record.id) {
    throw new CliError(`${label}缺少有效 ID`);
  }
  return record.id;
}

export function findRecordByCode(
  records: PermissionRecord[],
  code: string
): PermissionRecord | undefined {
  const normalized = code.trim().toLocaleLowerCase();
  return records.find(
    (record) =>
      typeof record.code === "string" &&
      record.code.trim().toLocaleLowerCase() === normalized
  );
}

export function assertFeatureGroupAppModule(
  featureGroup: PermissionRecord,
  appModule: PermissionRecord,
  appModuleId: string
): void {
  if (
    typeof featureGroup.appModuleId === "string" &&
    featureGroup.appModuleId &&
    featureGroup.appModuleId !== appModuleId
  ) {
    throw new CliError("功能项组与应用模块不一致");
  }
  if (
    typeof featureGroup.appModuleCode === "string" &&
    typeof appModule.code === "string" &&
    featureGroup.appModuleCode.trim().toLocaleLowerCase() !==
      appModule.code.trim().toLocaleLowerCase()
  ) {
    throw new CliError("功能项组与应用模块不一致");
  }
}

export function changedFeatureFields(
  before: PermissionRecord,
  desired: PermissionRecord
): string[] {
  return Object.keys(desired).filter(
    (field) => !sameFeatureValue(field, before[field], desired[field])
  );
}

export function normalizeFeatureDesired(desired: PermissionRecord): PermissionRecord {
  const normalized: PermissionRecord = { ...desired };
  if (typeof normalized.url === "string") {
    normalized.url = normalizeFeatureUrl(normalized.url);
  }
  return normalized;
}

export function normalizeFeatureUrl(value: string): string {
  const trimmed = value.trim();
  const withoutBoundarySlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutBoundarySlashes ? `/${withoutBoundarySlashes}` : "/";
}

export function sameFeatureValue(field: string, left: unknown, right: unknown): boolean {
  if (["canMenu", "tenantCanUse", "mobileUse"].includes(field)) {
    return (left ?? false) === (right ?? false);
  }
  if (field === "featureType") {
    const normalizedLeft =
      typeof left === "number" ? ["Operate", "Business", "Page"][left] : left;
    return normalizedLeft === right;
  }
  if (field === "url") {
    const normalizedLeft =
      typeof left === "string" ? normalizeFeatureUrl(left) : left;
    const normalizedRight =
      typeof right === "string" ? normalizeFeatureUrl(right) : right;
    return normalizedLeft === normalizedRight;
  }
  return left === right;
}

export function changedRoleFields(
  before: PermissionRecord | undefined,
  desired: PermissionRecord
): string[] {
  if (!before) {
    return [
      "code",
      "name",
      "featureRoleGroupId",
      "roleType",
      "ignoreParent",
      ...(desired.tenantCode === undefined ? [] : ["tenantCode"])
    ];
  }
  return [
    "code",
    "name",
    "featureRoleGroupId",
    "roleType",
    "ignoreParent",
    ...(desired.tenantCode === undefined ? [] : ["tenantCode"])
  ].filter((field) => before[field] !== desired[field]);
}

export function changedDataRoleFields(
  before: PermissionRecord | undefined,
  desired: PermissionRecord
): string[] {
  const fields = [
    "code",
    "name",
    "dataRoleGroupId",
    "ignoreParent",
    ...(desired.tenantCode === undefined ? [] : ["tenantCode"])
  ];
  if (!before) {
    return fields;
  }
  return fields.filter((field) => before[field] !== desired[field]);
}

export function uniqueRecords(
  records: PermissionRecord[],
  label = "功能项"
): PermissionRecord[] {
  const result = new Map<string, PermissionRecord>();
  for (const record of records) {
    result.set(recordId(record, label), record);
  }
  return [...result.values()];
}

export function principalRelationResource(
  subjectType: AssignPrincipalOptions["subjectType"],
  roleType: AssignPrincipalOptions["roleType"]
): string {
  if (subjectType === "user") {
    return roleType === "functional" ? "userFeatureRole" : "userDataRole";
  }
  if (subjectType === "position") {
    return roleType === "functional" ? "positionFeatureRole" : "positionDataRole";
  }
  return "positionCategoryFeatureRole";
}

export function validateVerifyOptions(
  options: VerifyOptions,
  resolvedUserId: string | null
): void {
  const requiresUserId =
    options.feature.length > 0 ||
    options.menu.length > 0 ||
    Boolean(options.entityClass);
  if (requiresUserId && !resolvedUserId) {
    throw new CliError(
      "按账号校验功能代码或数据范围时必须提供 --user-id；按员工号或姓名可自动解析"
    );
  }
  if (options.dataFeature && !options.entityClass) {
    throw new CliError("--data-feature 必须与 --entity-class 一起使用");
  }
  if (options.parentEntityId && options.parentEntityId !== "none" && !options.entityClass) {
    throw new CliError("--parent-entity-id 必须与 --entity-class 一起使用");
  }
}


export async function recordOperation(
  store: ConfigStore,
  environment: string,
  command: string,
  action: NewOperationAction
): Promise<string> {
  const recorder = new OperationRecorder(
    new OperationLogStore(store.directory),
    command,
    environment
  );
  await recorder.recordAction(action);
  return (await recorder.complete())!;
}
