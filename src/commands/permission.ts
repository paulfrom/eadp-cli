import { Command, Option } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore, type OperationAction } from "../operations/store.js";
import {
  PermissionClient,
  type PermissionRecord
} from "../permission/client.js";
import { inferProjectModuleName } from "../project/name.js";
import { getRuntimeOptions } from "../runtime-options.js";
import { assertTenantScope } from "../tenant.js";
import type { VerbCommands } from "./verbs.js";

type NewOperationAction = OperationAction extends infer Action
  ? Action extends OperationAction
    ? Omit<Action, "id" | "status">
    : never
  : never;

interface CommonOptions {
  env?: string;
  compact?: boolean;
}

interface InspectOptions extends CommonOptions {
  app?: string;
  role?: string;
}

interface ApplyRoleOptions extends CommonOptions {
  roleCode: string;
  roleName: string;
  group: string;
  roleType: string;
  ignoreParent?: boolean;
  apply?: boolean;
}

interface AssignFeatureOptions extends CommonOptions {
  role: string;
  feature: string[];
  apply?: boolean;
}

interface ApplyDataRoleOptions extends CommonOptions {
  roleCode: string;
  roleName: string;
  group: string;
  ignoreParent?: boolean;
  apply?: boolean;
}

interface AssignDataOptions extends CommonOptions {
  role: string;
  authType: string;
  entity: string[];
  parentEntityId?: string;
  apply?: boolean;
}

interface AssignPrincipalOptions extends CommonOptions {
  subjectType: "user" | "position" | "position-category";
  subject?: string;
  employeeCode?: string;
  employeeName?: string;
  roleType: "functional" | "data";
  role: string[];
  apply?: boolean;
}

interface AssignPermissionOptions extends CommonOptions {
  sourceEmployeeCode?: string;
  sourceEmployeeName?: string;
  targetEmployeeCode?: string;
  targetEmployeeName?: string;
  apply?: boolean;
}

interface VerifyOptions extends CommonOptions {
  user?: string;
  userId?: string;
  employeeCode?: string;
  employeeName?: string;
  feature: string[];
  menu: string[];
  entityClass?: string;
  dataFeature?: string;
  parentEntityId?: string;
}

interface FeatureUsersOptions extends CommonOptions {
  feature: string;
}

interface ApplyFeatureOptions extends CommonOptions {
  code: string;
  name: string;
  app: string;
  featureType: "Operate" | "Business" | "Page";
  group?: string;
  groupCode?: string;
  url?: string;
  canMenu?: boolean;
  tenantCanUse?: boolean;
  mobileUse?: boolean;
  apply?: boolean;
}

interface ApplyFeatureGroupOptions extends CommonOptions {
  code: string;
  name: string;
  appCode: string;
  project?: string;
  rank: number;
  apply?: boolean;
}

export function registerPermissionCommands(
  commands: Pick<
    VerbCommands,
    "inspect" | "apply" | "assign" | "revoke" | "verify"
  >,
  store: ConfigStore,
  root: Command
): void {
  const permission = commands.inspect
    .command("permission")
    .description("查看功能权限、数据权限及用户最终权限");

  const functional = permission
    .command("functional")
    .description("功能项、菜单、功能角色与授权树");

  functional
    .description("汇总应用、功能项、菜单、角色组和功能角色")
    .option("--app <code-or-id>", "只读取指定应用的功能项")
    .option("--role <code-or-id>", "同时读取指定角色的授权菜单功能树")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .addHelpText(
      "after",
      `
示例：
  eadp inspect permission functional
  eadp inspect permission functional --app BASIC --role ADMIN`
    )
    .action(async (options: InspectOptions) => {
      const context = await createContext(store, options, root);
      const [appModules, featureTypes, menus, roleGroups, roles] = await Promise.all([
        context.client.findAll("appModule"),
        context.client.getFeatureTypes(),
        context.client.getMenuTree(),
        context.client.findAll("featureRoleGroup"),
        context.client.findByPage("featureRole")
      ]);
      const appModule = options.app
        ? selectRecord(appModules, options.app, "应用模块")
        : undefined;
      const role = options.role
        ? selectRecord(roles, options.role, "功能角色")
        : undefined;
      const features = appModule
        ? await context.client.findFeaturesByAppModule(recordId(appModule, "应用模块"))
        : await context.client.findByPage("feature");
      const rolePermissions = role
        ? {
            role,
            authorizedMenuFeatureTree: await context.client.getRoleMenuFeatureTree(
              recordId(role, "功能角色")
            ),
            authorizedMenuRoots: await context.client.getAuthorizedMenuRoots(
              recordId(role, "功能角色")
            )
          }
        : null;

      printValue(
        {
          kind: "eadp.permission.functional.inspect.v1",
          environment: context.environment,
          scope: {
            appModule: appModule ?? null,
            role: role ?? null
          },
          appModules,
          featureTypes,
          features,
          menus,
          roleGroups,
          roles,
          rolePermissions
        },
        options.compact
      );
    });

  permission
    .command("users")
    .description("按功能代码反查拥有最终有效权限的用户")
    .requiredOption("--feature <code>", "功能项代码")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .addHelpText(
      "after",
      `
示例：
  eadp inspect permission users --feature BASIC_VIEW --env dev

逐个用户调用服务端最终权限判定，结果包含直接角色、岗位和岗位类别继承权限。`
    )
    .action(async (options: FeatureUsersOptions) => {
      const context = await createContext(store, options, root);
      const feature = selectFeatureByCode(
        await context.client.findByPage("feature"),
        options.feature
      );
      const featureCode = stringField(feature, "code", "功能项缺少代码");
      const allUsers = await context.client.findUsers();
      const users: PermissionRecord[] = [];
      const skippedUsers: PermissionRecord[] = [];
      for (const user of allUsers) {
        if (typeof user.id !== "string" || user.id === "") {
          skippedUsers.push(user);
          continue;
        }
        const checks = await context.client.checkUserFeatures(user.id, [featureCode]);
        if (checks[featureCode] === true) {
          users.push(user);
        }
      }
      printValue(
        {
          kind: "eadp.permission.feature-users.inspect.v1",
          environment: context.environment,
          feature,
          inspectedUserCount: allUsers.length - skippedUsers.length,
          authorizedUserCount: users.length,
          users,
          skippedUsers
        },
        options.compact
      );
    });

  commands.apply
    .command("feature")
    .description("只创建功能项；同 code 已存在时跳过，默认只预览")
    .requiredOption("--code <code>", "功能项代码")
    .requiredOption("--name <name>", "功能项名称")
    .requiredOption("--app <code-or-name-or-id>", "应用模块代码、名称或 ID")
    .addOption(
      new Option("--feature-type <type>", "功能项类型")
        .choices(["Operate", "Business", "Page"])
        .makeOptionMandatory()
    )
    .option("--group <code-or-name-or-id>", "功能项组代码、名称或 ID")
    .option("--group-code <code>", "功能项分组代码（页面路由）")
    .option("--url <url>", "功能项资源地址（操作接口 API）")
    .option("--can-menu", "标记为菜单功能项")
    .addOption(
      new Option("--tenant-can-use", "标记为租户可用（默认启用）").default(true)
    )
    .addOption(new Option("--no-tenant-can-use", "标记为租户不可用"))
    .option("--mobile-use", "标记为移动端使用")
    .option("--env <name>", "global 环境名称；默认使用当前环境")
    .option("--apply", "执行创建；默认只预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply feature --env global-dev --code BASIC_VIEW \\
    --name 查看基础数据 --app BASIC --feature-type Page --url /basic/view
  eadp apply feature --env global-dev --code BASIC_EXPORT \\
    --name 导出基础数据 --app BASIC --group BASIC_DATA \\
    --feature-type Operate --url /basic/export --apply

仅允许 tenantCode 为 global 的环境。Page 类型必须显式提供非空 --url；--url 未以 / 开头时自动补 /，
且不会从 --group-code 推断。Operate、Business 类型不受此必填规则影响。
创建时 appModule 与可选 featureGroup 会按代码、名称或 ID 唯一解析，写入时只使用解析出的 ID；
同 code 已存在时优先返回 unchanged，不调用 save。`
    )
    .action(async (options: ApplyFeatureOptions) => {
      await applyFeature(store, options, root);
    });

  commands.apply
    .command("feature-group")
    .description("只创建功能项组；同 code 已存在时跳过，默认只预览")
    .requiredOption("--code <code>", "功能项组代码")
    .requiredOption("--name <name>", "功能项组名称")
    .requiredOption("--app-code <code>", "应用模块代码")
    .option("--project <path>", "业务项目路径；用于推断新应用模块名称，默认当前路径")
    .option("--rank <number>", "新应用模块排序号", parsePositiveInteger, 1)
    .option("--env <name>", "global 环境名称；默认使用当前环境")
    .option("--apply", "执行创建；默认只预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply feature-group --env global-dev --app-code AMS \
    --code AMS_ORDER --name 订单功能组 --project D:/project/order
  eadp apply feature-group --env global-dev --app-code AMS \
    --code AMS_ORDER --name 订单功能组 --apply

应用模块按明确 code 唯一解析；缺失时从业务项目名称或代码注释推断不超过 8 个字的名称，
rank 默认 1，并在同一次 --apply 中先创建应用模块、回查，再创建功能项组、回查。两项新增
共用一个 operationId，可显式执行 eadp rollback <operationId> 按逆序删除。仅允许 tenantCode === "global"。`
    )
    .action(async (options: ApplyFeatureGroupOptions) => {
      await applyFeatureGroup(store, options, root);
    });

  commands.apply
    .command("functional-role")
    .description("幂等创建或更新一个功能角色；默认只预览")
    .requiredOption("--role-code <code>", "功能角色代码")
    .requiredOption("--role-name <name>", "功能角色名称")
    .requiredOption("--group <code-or-id>", "功能角色组代码、名称或 ID")
    .addOption(
      new Option("--role-type <type>", "角色类型")
        .choices(["CanUse", "CanAssign"])
        .default("CanUse")
    )
    .option("--ignore-parent", "忽略上级公共角色")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply functional-role --role-code BASIC_READER \\
    --role-name 基础只读角色 --group BASIC_ROLE
  eadp apply functional-role --role-code BASIC_READER \\
    --role-name 基础只读角色 --group BASIC_ROLE --apply`
    )
    .action(async (options: ApplyRoleOptions) => {
      const context = await createContext(store, options, root);
      const [groups, roles] = await Promise.all([
        context.client.findAll("featureRoleGroup"),
        context.client.findByPage("featureRole")
      ]);
      const group = selectRecord(groups, options.group, "功能角色组");
      const existing = findRecordByCode(roles, options.roleCode);
      const desired: PermissionRecord = {
        ...(existing ?? {}),
        code: options.roleCode,
        name: options.roleName,
        featureRoleGroupId: recordId(group, "功能角色组"),
        roleType: options.roleType,
        ignoreParent: options.ignoreParent ?? existing?.ignoreParent ?? false,
        tenantCode: context.tenantCode
      };
      const changedFields = changedRoleFields(existing, desired);
      const action =
        existing === undefined
          ? "create"
          : changedFields.length > 0
            ? "update"
            : "unchanged";

      if (!options.apply || action === "unchanged") {
        printValue(
          {
            kind: "eadp.permission.functional.apply-role.v1",
            environment: context.environment,
            applied: false,
            action,
            changedFields,
            group,
            before: existing ?? null,
            desired,
            verified: action === "unchanged"
          },
          options.compact
        );
        return;
      }

      const saved = await context.client.save("featureRole", desired);
      const operationId = action === "create"
        ? await recordOperation(store, context.environment, "eadp apply functional-role", {
            type: "create-entity",
            service: "sei-basic",
            resource: "featureRole",
            entityId: recordId(saved, "功能角色"),
            expected: desired,
            deleteMethod: "DELETE"
          })
        : undefined;
      const verifiedRole = await context.client.findFeatureRoleByCode(options.roleCode);
      const verified =
        verifiedRole !== null &&
        changedRoleFields(verifiedRole, desired).length === 0;
      if (!verified) {
        throw new CliError(`功能角色写入后回查失败：${options.roleCode}`);
      }
      printValue(
        {
          kind: "eadp.permission.functional.apply-role.v1",
          environment: context.environment,
          applied: true,
          action,
          changedFields,
          group,
          before: existing ?? null,
          saved,
          ...(operationId ? { operationId } : {}),
          verified,
          verifiedRole
        },
        options.compact
      );
    });

  commands.assign
    .command("permission")
    .description("差异复制用户权限：补充直接功能角色、数据角色和岗位关系")
    .option("--source-employee-code <code>", "源员工号；与 --source-employee-name 二选一")
    .option("--source-employee-name <name>", "源员工姓名；必须精确且唯一")
    .option("--target-employee-code <code>", "目标员工号；与 --target-employee-name 二选一")
    .option("--target-employee-name <name>", "目标员工姓名；必须精确且唯一")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp assign permission --env dev \\
    --source-employee-code E1001 --target-employee-code E1002
  eadp assign permission --env dev \\
    --source-employee-name 张三 --target-employee-name 李四 --apply

仅复制源员工直接分配的功能角色、数据角色和全部岗位；公共角色（功能/数据角色中存在
publicUserType）会跳过。默认只预览，--apply 只新增缺失关系，绝不移除目标已有关系。`
    )
    .action(async (options: AssignPermissionOptions) => {
      await assignPermission(store, options, root);
    });

  commands.assign
    .command("feature")
    .description("幂等地给功能角色补充分配功能项；不会移除已有权限")
    .requiredOption("--role <code-or-id>", "功能角色代码、名称或 ID")
    .addOption(
      new Option("--feature <code-or-id>", "功能项代码、名称或 ID，可重复")
        .makeOptionMandatory()
        .default([])
        .argParser(collect)
    )
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp assign feature --role BASIC_READER \\
    --feature BASIC_VIEW --feature BASIC_EXPORT
  eadp assign feature --role BASIC_READER \\
    --feature BASIC_VIEW --feature BASIC_EXPORT --apply

安全规则：只补充缺失功能项，不会移除角色已有权限。`
    )
    .action(async (options: AssignFeatureOptions) => {
      const context = await createContext(store, options, root);
      const [roles, features] = await Promise.all([
        context.client.findByPage("featureRole"),
        context.client.findByPage("feature")
      ]);
      const role = selectRecord(roles, options.role, "功能角色");
      const requestedFeatures = uniqueRecords(
        options.feature.map((selector) =>
          selectRecord(features, selector, "功能项")
        )
      );
      const roleId = recordId(role, "功能角色");
      const assignedBefore = await context.client.getChildren(
        "featureRoleFeature",
        roleId
      );
      const assignedIds = new Set(
        assignedBefore
          .map((feature) => feature.id)
          .filter((id): id is string => typeof id === "string")
      );
      const missingFeatures = requestedFeatures.filter(
        (feature) => !assignedIds.has(recordId(feature, "功能项"))
      );
      const addedFeatureIds = missingFeatures.map((feature) =>
        recordId(feature, "功能项")
      );

      let operationId: string | undefined;
      if (options.apply && addedFeatureIds.length > 0) {
        await context.client.insertRelations(
          "featureRoleFeature",
          roleId,
          addedFeatureIds
        );
        operationId = await recordOperation(store, context.environment, "eadp assign feature", {
          type: "assign-relations",
          service: "sei-basic",
          resource: "featureRoleFeature",
          parentId: roleId,
          childIds: addedFeatureIds
        });
      }
      const assignedAfter = options.apply
        ? await context.client.getChildren("featureRoleFeature", roleId)
        : assignedBefore;
      const verifiedIds = new Set(
        assignedAfter
          .map((feature) => feature.id)
          .filter((id): id is string => typeof id === "string")
      );
      const verified = requestedFeatures.every((feature) =>
        verifiedIds.has(recordId(feature, "功能项"))
      );
      if (options.apply && !verified) {
        throw new CliError(
          `功能项分配后回查失败：${missingFeatures
            .map((feature) => String(feature.code ?? feature.id))
            .join(", ")}`
        );
      }

      printValue(
        {
          kind: "eadp.permission.functional.assign-features.v1",
          environment: context.environment,
          applied: options.apply === true && addedFeatureIds.length > 0,
          action:
            addedFeatureIds.length === 0
              ? "unchanged"
              : options.apply
                ? "assigned"
                : "preview",
          role,
          requestedFeatures,
          alreadyAssignedFeatureIds: requestedFeatures
            .map((feature) => recordId(feature, "功能项"))
            .filter((id) => assignedIds.has(id)),
          addedFeatureIds,
          ...(operationId ? { operationId } : {}),
          verified: options.apply ? verified : addedFeatureIds.length === 0
        },
        options.compact
      );
    });

  const data = permission
    .command("data")
    .description("权限对象、权限类型、数据角色与数据范围");

  data
    .description("汇总权限对象类型、数据权限类型和数据角色")
    .option("--role <code-or-id>", "同时读取指定数据角色包含的权限类型")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .addHelpText(
      "after",
      `
示例：
  eadp inspect permission data
  eadp inspect permission data --role ORG_ADMIN

安全说明：不读取角色已分配的数据值，因为对应查询会自动删除远端失效关系。`
    )
    .action(async (options: InspectOptions) => {
      const context = await createContext(store, options, root);
      const [authorizeEntityTypes, dataAuthorizeTypes, roleGroups] =
        await Promise.all([
          context.client.findAll("authorizeEntityType"),
          context.client.findAll("dataAuthorizeType"),
          context.client.findAll("dataRoleGroup")
        ]);
      const roles = await context.client.findDataRoles(roleGroups);
      const role = options.role
        ? selectRecord(roles, options.role, "数据角色")
        : undefined;
      const roleAuthorizationTypes = role
        ? await context.client.getRoleAuthorizationTypes(recordId(role, "数据角色"))
        : null;

      printValue(
        {
          kind: "eadp.permission.data.inspect.v1",
          environment: context.environment,
          scope: { role: role ?? null },
          authorizeEntityTypes,
          dataAuthorizeTypes,
          roleGroups,
          roles,
          roleAuthorizationTypes,
          warnings: [
            "为保持只读，未读取已分配数据值；相关服务端查询会自动清理失效授权关系。"
          ]
        },
        options.compact
      );
    });

  commands.apply
    .command("data-role")
    .description("幂等创建或更新一个数据角色；默认只预览")
    .requiredOption("--role-code <code>", "数据角色代码")
    .requiredOption("--role-name <name>", "数据角色名称")
    .requiredOption("--group <code-or-id>", "数据角色组代码、名称或 ID")
    .option("--ignore-parent", "忽略上级公共角色")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp apply data-role --role-code ORG_READER \\
    --role-name 组织只读角色 --group ORG_ROLE
  eadp apply data-role --role-code ORG_READER \\
    --role-name 组织只读角色 --group ORG_ROLE --apply`
    )
    .action(async (options: ApplyDataRoleOptions) => {
      const context = await createContext(store, options, root);
      const groups = await context.client.findAll("dataRoleGroup");
      const roles = await context.client.findDataRoles(groups);
      const group = selectRecord(groups, options.group, "数据角色组");
      const existing = findRecordByCode(roles, options.roleCode);
      const desired: PermissionRecord = {
        ...(existing ?? {}),
        code: options.roleCode,
        name: options.roleName,
        dataRoleGroupId: recordId(group, "数据角色组"),
        ignoreParent: options.ignoreParent ?? existing?.ignoreParent ?? false,
        tenantCode: context.tenantCode
      };
      const changedFields = changedDataRoleFields(existing, desired);
      const action =
        existing === undefined
          ? "create"
          : changedFields.length > 0
            ? "update"
            : "unchanged";

      if (!options.apply || action === "unchanged") {
        printValue(
          {
            kind: "eadp.permission.data.apply-role.v1",
            environment: context.environment,
            applied: false,
            action,
            changedFields,
            group,
            before: existing ?? null,
            desired,
            verified: action === "unchanged"
          },
          options.compact
        );
        return;
      }

      const saved = await context.client.save("dataRole", desired);
      const operationId = action === "create"
        ? await recordOperation(store, context.environment, "eadp apply data-role", {
            type: "create-entity",
            service: "sei-basic",
            resource: "dataRole",
            entityId: recordId(saved, "数据角色"),
            expected: desired,
            deleteMethod: "DELETE"
          })
        : undefined;
      const verifiedRole = findRecordByCode(
        await context.client.findDataRoles(),
        options.roleCode
      );
      const verified =
        verifiedRole !== undefined &&
        changedDataRoleFields(verifiedRole, desired).length === 0;
      if (!verified) {
        throw new CliError(`数据角色写入后回查失败：${options.roleCode}`);
      }
      printValue(
        {
          kind: "eadp.permission.data.apply-role.v1",
          environment: context.environment,
          applied: true,
          action,
          changedFields,
          group,
          before: existing ?? null,
          saved,
          ...(operationId ? { operationId } : {}),
          verified,
          verifiedRole
        },
        options.compact
      );
    });

  commands.assign
    .command("data")
    .description("幂等地给数据角色补充授权数据值；默认只预览")
    .requiredOption("--role <code-or-id>", "数据角色代码、名称或 ID")
    .requiredOption("--auth-type <code-or-id>", "数据权限类型代码、名称或 ID")
    .addOption(
      new Option("--entity <id>", "要授权的业务数据 ID，可重复")
        .makeOptionMandatory()
        .default([])
        .argParser(collect)
    )
    .option("--parent-entity-id <id>", "级联权限的父级业务数据 ID")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入并回查；回查可能清理远端失效关系")
    .addHelpText(
      "after",
      `
示例：
  eadp assign data --role ORG_READER --auth-type ORG \\
    --entity <组织ID>
  eadp assign data --role ORG_READER --auth-type ORG \\
    --entity <组织ID> --apply

预览模式不会读取已分配值。正式执行会先后回查授权值，这些服务端查询可能自动清理
已经不存在的授权关系。insertRelations 本身会去重，重复执行不会产生重复关系。`
    )
    .action(async (options: AssignDataOptions) => {
      const context = await createContext(store, options, root);
      const [roles, authorizeTypes] = await Promise.all([
        context.client.findDataRoles(),
        context.client.findAll("dataAuthorizeType")
      ]);
      const role = selectRecord(roles, options.role, "数据角色");
      const authorizeType = selectRecord(
        authorizeTypes,
        options.authType,
        "数据权限类型"
      );
      const requestedEntityIds = [...new Set(options.entity)];
      const roleId = recordId(role, "数据角色");
      const authorizeTypeId = recordId(authorizeType, "数据权限类型");
      const includesChildren = authorizeType.treeEntityIncludeChildren === true;

      if (!options.apply) {
        printValue(
          {
            kind: "eadp.permission.data.assign-values.v1",
            environment: context.environment,
            applied: false,
            action: "preview",
            role,
            authorizeType,
            parentEntityId: options.parentEntityId ?? null,
            requestedEntityIds,
            cleanupMayOccur: false,
            verificationMode: includesChildren ? "server-normalized-tree" : "exact",
            verified: false
          },
          options.compact
        );
        return;
      }

      const assignedBefore = await context.client.getAssignedDataValues({
        dataRoleId: roleId,
        dataAuthorizeTypeId: authorizeTypeId,
        ...(options.parentEntityId === undefined
          ? {}
          : { parentEntityId: options.parentEntityId })
      });
      const assignedIds = new Set(
        assignedBefore
          .map((entity) => entity.id)
          .filter((id): id is string => typeof id === "string")
      );
      const addedEntityIds = requestedEntityIds.filter(
        (entityId) => !assignedIds.has(entityId)
      );
      await context.client.insertDataValues({
        dataRoleId: roleId,
        dataAuthorizeTypeId: authorizeTypeId,
        entityIds: addedEntityIds,
        ...(options.parentEntityId === undefined
          ? {}
          : { parentEntityId: options.parentEntityId })
      });
      const operationId = addedEntityIds.length > 0
        ? await recordOperation(store, context.environment, "eadp assign data", {
            type: "assign-data-values",
            service: "sei-basic",
            resource: "dataRoleAuthTypeValue",
            dataRoleId: roleId,
            dataAuthorizeTypeId: authorizeTypeId,
            entityIds: addedEntityIds,
            ...(options.parentEntityId === undefined
              ? {}
              : { parentEntityId: options.parentEntityId })
          })
        : undefined;
      const assignedAfter = await context.client.getAssignedDataValues({
        dataRoleId: roleId,
        dataAuthorizeTypeId: authorizeTypeId,
        ...(options.parentEntityId === undefined
          ? {}
          : { parentEntityId: options.parentEntityId })
      });
      const verifiedIds = new Set(
        assignedAfter
          .map((entity) => entity.id)
          .filter((id): id is string => typeof id === "string")
      );
      const verified = includesChildren
        ? assignedAfter.length > 0 || requestedEntityIds.length === 0
        : requestedEntityIds.every((id) => verifiedIds.has(id));
      if (!verified) {
        throw new CliError(
          `数据范围分配后回查失败：${requestedEntityIds
            .filter((id) => !verifiedIds.has(id))
            .join(", ")}`
        );
      }
      printValue(
        {
          kind: "eadp.permission.data.assign-values.v1",
          environment: context.environment,
          applied: addedEntityIds.length > 0,
          action: addedEntityIds.length > 0 ? "assigned" : "unchanged",
          role,
          authorizeType,
          parentEntityId: options.parentEntityId ?? null,
          requestedEntityIds,
          alreadyAssignedEntityIds: requestedEntityIds.filter((id) =>
            assignedIds.has(id)
          ),
          addedEntityIds,
          ...(operationId ? { operationId } : {}),
          cleanupMayOccur: true,
          verificationMode: includesChildren ? "server-normalized-tree" : "exact",
          verified
        },
        options.compact
      );
    });

  commands.assign
    .command("role")
    .description("幂等补充主体角色；不会移除已有角色")
    .addOption(
      new Option("--subject-type <type>", "授权主体类型")
        .choices(["user", "position", "position-category"])
        .makeOptionMandatory()
    )
    .option(
      "--subject <code-or-id>",
      "用户账号、岗位代码、岗位类别代码或对应 ID"
    )
    .option("--employee-code <code>", "按员工号选择用户主体")
    .option("--employee-name <name>", "按员工姓名选择用户主体；重名时终止")
    .addOption(
      new Option("--role-type <type>", "角色类型")
        .choices(["functional", "data"])
        .makeOptionMandatory()
    )
    .addOption(
      new Option("--role <code-or-id>", "角色代码、名称或 ID，可重复")
        .makeOptionMandatory()
        .default([])
        .argParser(collect)
    )
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp assign role --subject-type user --subject lin \\
    --role-type functional --role BASIC_READER
  eadp assign role --subject-type position --subject FIN_MANAGER \\
    --role-type data --role ORG_READER --apply

用户可按 account、员工号或员工姓名匹配；岗位和岗位类别可按 code 匹配。
--subject、--employee-code、--employee-name 三选一。岗位类别只支持功能角色。`
    )
    .action(async (options: AssignPrincipalOptions) => {
      if (options.subjectType === "position-category" && options.roleType === "data") {
        throw new CliError("岗位类别不支持直接分配数据角色");
      }
      const context = await createContext(store, options, root);
      const subjectResource =
        options.subjectType === "user"
          ? "user"
          : options.subjectType === "position"
            ? "position"
            : "positionCategory";
      const relationResource = principalRelationResource(
        options.subjectType,
        options.roleType
      );
      const roles =
        options.roleType === "functional"
          ? await context.client.findByPage("featureRole")
          : await context.client.findDataRoles();
      const subject = await resolvePrincipalSubject(
        context.client,
        options,
        subjectResource
      );
      const requestedRoles = uniqueRecords(
        options.role.map((selector) => selectRecord(roles, selector, "角色")),
        "角色"
      );
      const subjectId = recordId(subject, "授权主体");
      const assignedBefore = await context.client.getChildren(
        relationResource,
        subjectId
      );
      const assignedIds = new Set(
        assignedBefore
          .map((role) => role.id)
          .filter((id): id is string => typeof id === "string")
      );
      const missingRoles = requestedRoles.filter(
        (role) => !assignedIds.has(recordId(role, "角色"))
      );
      const addedRoleIds = missingRoles.map((role) => recordId(role, "角色"));

      let operationId: string | undefined;
      if (options.apply && addedRoleIds.length > 0) {
        await context.client.insertRelations(
          relationResource,
          subjectId,
          addedRoleIds
        );
        operationId = await recordOperation(store, context.environment, "eadp assign role", {
          type: "assign-relations",
          service: "sei-basic",
          resource: relationResource,
          parentId: subjectId,
          childIds: addedRoleIds
        });
      }
      const assignedAfter = options.apply
        ? await context.client.getChildren(relationResource, subjectId)
        : assignedBefore;
      const verifiedIds = new Set(
        assignedAfter
          .map((role) => role.id)
          .filter((id): id is string => typeof id === "string")
      );
      const verified = requestedRoles.every((role) =>
        verifiedIds.has(recordId(role, "角色"))
      );
      if (options.apply && !verified) {
        throw new CliError(
          `主体角色分配后回查失败：${missingRoles
            .map((role) => String(role.code ?? role.id))
            .join(", ")}`
        );
      }
      printValue(
        {
          kind: "eadp.permission.principal.assign-roles.v1",
          environment: context.environment,
          applied: options.apply === true && addedRoleIds.length > 0,
          action:
            addedRoleIds.length === 0
              ? "unchanged"
              : options.apply
                ? "assigned"
                : "preview",
          subjectType: options.subjectType,
          roleType: options.roleType,
          relationResource,
          subject,
          requestedRoles,
          alreadyAssignedRoleIds: requestedRoles
            .map((role) => recordId(role, "角色"))
            .filter((id) => assignedIds.has(id)),
          addedRoleIds,
          ...(operationId ? { operationId } : {}),
          verified: options.apply ? verified : addedRoleIds.length === 0
        },
        options.compact
      );
    });

  commands.revoke
    .command("role")
    .description("幂等移除主体的指定角色；默认只预览")
    .addOption(
      new Option("--subject-type <type>", "授权主体类型")
        .choices(["user", "position", "position-category"])
        .makeOptionMandatory()
    )
    .option(
      "--subject <code-or-id>",
      "用户账号、岗位代码、岗位类别代码或对应 ID"
    )
    .option("--employee-code <code>", "按员工号选择用户主体")
    .option("--employee-name <name>", "按员工姓名选择用户主体；重名时终止")
    .addOption(
      new Option("--role-type <type>", "角色类型")
        .choices(["functional", "data"])
        .makeOptionMandatory()
    )
    .addOption(
      new Option("--role <code-or-id>", "要移除的角色代码、名称或 ID，可重复")
        .makeOptionMandatory()
        .default([])
        .argParser(collect)
    )
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--apply", "执行移除；不提供时仅输出差异预览")
    .addHelpText(
      "after",
      `
示例：
  eadp revoke role --subject-type user --employee-code E1001 \\
    --role-type functional --role BASIC_READER
  eadp revoke role --subject-type user --subject lin \\
    --role-type data --role ORG_READER --apply

安全规则：默认只预览；只移除明确列出的角色，不影响主体的其他角色。`
    )
    .action(async (options: AssignPrincipalOptions) => {
      if (options.subjectType === "position-category" && options.roleType === "data") {
        throw new CliError("岗位类别不支持直接分配数据角色");
      }
      const context = await createContext(store, options, root);
      const subjectResource =
        options.subjectType === "user"
          ? "user"
          : options.subjectType === "position"
            ? "position"
            : "positionCategory";
      const relationResource = principalRelationResource(
        options.subjectType,
        options.roleType
      );
      const roles =
        options.roleType === "functional"
          ? await context.client.findByPage("featureRole")
          : await context.client.findDataRoles();
      const subject = await resolvePrincipalSubject(
        context.client,
        options,
        subjectResource
      );
      const requestedRoles = uniqueRecords(
        options.role.map((selector) => selectRecord(roles, selector, "角色")),
        "角色"
      );
      const subjectId = recordId(subject, "授权主体");
      const assignedBefore = await context.client.getChildren(
        relationResource,
        subjectId
      );
      const assignedIds = new Set(
        assignedBefore
          .map((role) => role.id)
          .filter((id): id is string => typeof id === "string")
      );
      const removableRoles = requestedRoles.filter((role) =>
        assignedIds.has(recordId(role, "角色"))
      );
      const removedRoleIds = removableRoles.map((role) =>
        recordId(role, "角色")
      );

      if (options.apply && removedRoleIds.length > 0) {
        await context.client.removeRelations(
          relationResource,
          subjectId,
          removedRoleIds
        );
      }
      const assignedAfter = options.apply
        ? await context.client.getChildren(relationResource, subjectId)
        : assignedBefore;
      const afterIds = new Set(
        assignedAfter
          .map((role) => role.id)
          .filter((id): id is string => typeof id === "string")
      );
      const verified = removedRoleIds.every((id) => !afterIds.has(id));
      if (options.apply && !verified) {
        throw new CliError(
          `主体角色移除后回查失败：${removableRoles
            .map((role) => String(role.code ?? role.id))
            .join(", ")}`
        );
      }
      printValue(
        {
          kind: "eadp.permission.principal.revoke-roles.v1",
          environment: context.environment,
          applied: options.apply === true && removedRoleIds.length > 0,
          action:
            removedRoleIds.length === 0
              ? "unchanged"
              : options.apply
                ? "revoked"
                : "preview",
          subjectType: options.subjectType,
          roleType: options.roleType,
          relationResource,
          subject,
          requestedRoles,
          notAssignedRoleIds: requestedRoles
            .map((role) => recordId(role, "角色"))
            .filter((id) => !assignedIds.has(id)),
          removedRoleIds,
          verified: options.apply ? verified : removedRoleIds.length === 0
        },
        options.compact
      );
    });

  commands.verify
    .description("按账号、员工号或员工姓名回查角色及有效权限")
    .option("--user <account>", "用户账号")
    .option("--employee-code <code>", "员工号")
    .option("--employee-name <name>", "员工姓名；重名时终止")
    .option("--user-id <id>", "用户 ID；校验功能代码或数据范围时必填")
    .addOption(
      new Option("--feature <code>", "要校验的功能项代码，可重复")
        .default([])
        .argParser(collect)
    )
    .addOption(
      new Option("--menu <code-or-name>", "要校验的菜单代码、名称或路径，可重复")
        .default([])
        .argParser(collect)
    )
    .option("--entity-class <name>", "要校验的数据权限实体全限定类名")
    .option("--data-feature <code>", "数据权限对应的功能项代码", "")
    .option("--parent-entity-id <id>", "级联数据权限的父实体 ID", "none")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .addHelpText(
      "after",
      `
示例：
  eadp verify --user lin
  eadp verify --employee-code E1001
  eadp verify --employee-name 张三
  eadp verify --employee-code E1001 --menu 租户管理
  eadp verify --user lin --user-id <用户ID> --feature BASIC_VIEW
  eadp verify --user lin --user-id <用户ID> \\
    --entity-class com.example.Organization --data-feature BASIC_VIEW`
    )
    .action(async (options: VerifyOptions) => {
      const context = await createContext(store, options, root);
      const resolvedUser = await resolveVerifyUser(context.client, options);
      validateVerifyOptions(options, resolvedUser.userId);
      const [featureRoles, dataRoles] = await Promise.all([
        context.client.getFeatureRolesByAccount(resolvedUser.account),
        context.client.getDataRolesByAccount(resolvedUser.account)
      ]);
      const featureChecks =
        resolvedUser.userId && options.feature.length > 0
          ? await context.client.checkUserFeatures(resolvedUser.userId, options.feature)
          : null;
      const menuChecks =
        resolvedUser.userId && options.menu.length > 0
          ? await checkUserMenus(
              context.client,
              resolvedUser.userId,
              options.menu
            )
          : null;
      const authorizedEntityIds =
        resolvedUser.userId && options.entityClass
          ? await context.client.getAuthorizedEntityIds({
              userId: resolvedUser.userId,
              entityClassName: options.entityClass,
              ...(options.dataFeature === undefined
                ? {}
                : { featureCode: options.dataFeature }),
              ...(options.parentEntityId === undefined
                ? {}
                : { parentEntityId: options.parentEntityId })
            })
          : null;

      printValue(
        {
          kind: "eadp.permission.verify.v1",
          environment: context.environment,
          user: resolvedUser,
          featureRoles,
          dataRoles,
          featureChecks,
          menuChecks,
          authorizedEntityIds,
          notes:
            resolvedUser.userId === null
              ? ["未提供 --user-id，本次只回查账号直接及继承的角色。"]
              : []
        },
        options.compact
      );
    });
}

async function applyFeature(
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

  const desired = normalizeFeatureDesired({
    code,
    name,
    featureType: options.featureType,
    appModuleId,
    canMenu: options.canMenu === true,
    tenantCanUse: options.tenantCanUse !== false,
    mobileUse: options.mobileUse === true,
    ...(featureGroup
      ? { featureGroupId: recordId(featureGroup, "功能项组") }
      : {}),
    ...(options.groupCode === undefined ? {} : { groupCode: options.groupCode }),
    ...(options.url === undefined ? {} : { url: normalizeFeatureUrl(options.url) })
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
  const operationId = await recordOperation(store, context.environment, "eadp apply feature", {
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

async function applyFeatureGroup(
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
    "eadp apply feature-group",
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

function sameFields(
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

async function createContext(
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
      timeoutMs: runtime.timeoutMs
    })
  };
}

async function createGlobalContext(
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
      timeoutMs: runtime.timeoutMs
    })
  };
}

type PermissionCopyCategory = "functionalRoles" | "dataRoles" | "positions";

interface PermissionCopyDiff {
  category: PermissionCopyCategory;
  resource: "userFeatureRole" | "userDataRole" | "employeePosition";
  source: PermissionRecord[];
  eligible: PermissionRecord[];
  skippedPublic: PermissionRecord[];
  alreadyAssigned: PermissionRecord[];
  added: PermissionRecord[];
}

interface PermissionCopyRelations {
  functionalRoles: PermissionRecord[];
  dataRoles: PermissionRecord[];
  positions: PermissionRecord[];
}

async function assignPermission(
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
        "eadp assign permission",
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

async function resolvePermissionEmployee(
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

function assertPermissionEmployeeTenant(
  employee: PermissionRecord,
  tenantCode: string,
  label: string
): void {
  if (typeof employee.tenantCode === "string" && employee.tenantCode !== tenantCode) {
    throw new CliError(`${label}不属于当前环境租户：${employee.tenantCode}`);
  }
}

async function readPermissionRelations(
  client: PermissionClient,
  employeeId: string
): Promise<PermissionCopyRelations> {
  return {
    functionalRoles: await client.getChildren("userFeatureRole", employeeId),
    dataRoles: await client.getChildren("userDataRole", employeeId),
    positions: await client.getChildren("employeePosition", employeeId)
  };
}

function buildPermissionCopyDiffs(
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

function createPermissionCopyDiff(
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

function isPublicPermissionRole(record: PermissionRecord): boolean {
  return record.publicUserType !== null && record.publicUserType !== undefined;
}

function permissionRelationId(record: PermissionRecord): string {
  if (typeof record.id === "string" && record.id) return record.id;
  if (typeof record.childId === "string" && record.childId) return record.childId;
  if (isPermissionRecord(record.child) && typeof record.child.id === "string" && record.child.id) {
    return record.child.id;
  }
  throw new CliError("权限关系缺少有效子实体 ID");
}

function toPermissionCopyRelations(
  diffs: PermissionCopyDiff[],
  field: "source" | "skippedPublic" | "alreadyAssigned" | "added"
): PermissionCopyRelations {
  return {
    functionalRoles: diffs.find((diff) => diff.category === "functionalRoles")![field],
    dataRoles: diffs.find((diff) => diff.category === "dataRoles")![field],
    positions: diffs.find((diff) => diff.category === "positions")![field]
  };
}

function buildPermissionCopyCounts(
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

function verifyPermissionCopy(
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

function selectFeatureByCode(
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

function selectRecord(
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

async function resolvePrincipalSubject(
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

async function resolveVerifyUser(
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

async function resolveEmployee(
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

function stringField(
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

async function checkUserMenus(
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

function flattenMenuTree(menus: PermissionRecord[]): PermissionRecord[] {
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

function selectMenu(
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

function collectMenuFeatureCodes(menu: PermissionRecord): string[] {
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

function isPermissionRecord(value: unknown): value is PermissionRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordId(record: PermissionRecord, label: string): string {
  if (typeof record.id !== "string" || !record.id) {
    throw new CliError(`${label}缺少有效 ID`);
  }
  return record.id;
}

function findRecordByCode(
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

function assertFeatureGroupAppModule(
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

function changedFeatureFields(
  before: PermissionRecord,
  desired: PermissionRecord
): string[] {
  return Object.keys(desired).filter(
    (field) => !sameFeatureValue(field, before[field], desired[field])
  );
}

function normalizeFeatureDesired(desired: PermissionRecord): PermissionRecord {
  const normalized: PermissionRecord = { ...desired };
  if (typeof normalized.url === "string") {
    normalized.url = normalizeFeatureUrl(normalized.url);
  }
  if (normalized.featureType === "Business") {
    normalized.canMenu = false;
  }
  return normalized;
}

function normalizeFeatureUrl(value: string): string {
  const trimmed = value.trim();
  const withoutBoundarySlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutBoundarySlashes ? `/${withoutBoundarySlashes}` : "/";
}

function sameFeatureValue(field: string, left: unknown, right: unknown): boolean {
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

function changedRoleFields(
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

function changedDataRoleFields(
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

function uniqueRecords(
  records: PermissionRecord[],
  label = "功能项"
): PermissionRecord[] {
  const result = new Map<string, PermissionRecord>();
  for (const record of records) {
    result.set(recordId(record, label), record);
  }
  return [...result.values()];
}

function principalRelationResource(
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

function validateVerifyOptions(
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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(source: string): number {
  const value = Number(source);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(`应用模块排序号无效：${source}`);
  }
  return value;
}

async function recordOperation(
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
