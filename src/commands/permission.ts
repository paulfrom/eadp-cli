import { Command, Option } from "commander";
import { resolveEnvironment } from "../config/resolve.js";
import { ConfigStore } from "../config/store.js";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import {
  PermissionClient,
  type PermissionRecord
} from "../permission/client.js";

interface CommonOptions {
  env?: string;
  timeout: string;
  json?: boolean;
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
  tenantCode?: string;
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
  tenantCode?: string;
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

export function registerPermissionCommands(program: Command, store: ConfigStore): void {
  const permission = program
    .command("permission")
    .description("检查 EADP 功能权限、数据权限及用户最终权限")
    .addHelpText(
      "after",
      `
全新上下文推荐流程：
  1. eadp permission functional inspect --json
  2. eadp permission data inspect --json
  3. eadp permission verify --user <账号> --json

inspect 只读取远端配置。数据权限检查不会调用带有失效关系自动清理副作用的接口。`
    );

  const functional = permission
    .command("functional")
    .description("功能项、菜单、功能角色与授权树");

  functional
    .command("inspect")
    .description("汇总应用、功能项、菜单、角色组和功能角色")
    .option("--app <code-or-id>", "只读取指定应用的功能项")
    .option("--role <code-or-id>", "同时读取指定角色的授权菜单功能树")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission functional inspect --json
  eadp permission functional inspect --app BASIC --role ADMIN --json`
    )
    .action(async (options: InspectOptions) => {
      const context = await createContext(store, options);
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

  functional
    .command("apply")
    .description("幂等创建或更新一个功能角色；默认只预览")
    .requiredOption("--role-code <code>", "功能角色代码")
    .requiredOption("--role-name <name>", "功能角色名称")
    .requiredOption("--group <code-or-id>", "功能角色组代码、名称或 ID")
    .addOption(
      new Option("--role-type <type>", "角色类型")
        .choices(["CanUse", "CanAssign"])
        .default("CanUse")
    )
    .option("--tenant-code <code>", "租户代码；不提供时由服务端上下文确定")
    .option("--ignore-parent", "忽略上级公共角色")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission functional apply --role-code BASIC_READER \\
    --role-name 基础只读角色 --group BASIC_ROLE --json
  eadp permission functional apply --role-code BASIC_READER \\
    --role-name 基础只读角色 --group BASIC_ROLE --apply --json`
    )
    .action(async (options: ApplyRoleOptions) => {
      const context = await createContext(store, options);
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
        ...(options.tenantCode === undefined
          ? {}
          : { tenantCode: options.tenantCode })
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
          verified,
          verifiedRole
        },
        options.compact
      );
    });

  functional
    .command("assign")
    .description("幂等地给功能角色补充分配功能项；不会移除已有权限")
    .requiredOption("--role <code-or-id>", "功能角色代码、名称或 ID")
    .addOption(
      new Option("--feature <code-or-id>", "功能项代码、名称或 ID，可重复")
        .makeOptionMandatory()
        .default([])
        .argParser(collect)
    )
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission functional assign --role BASIC_READER \\
    --feature BASIC_VIEW --feature BASIC_EXPORT --json
  eadp permission functional assign --role BASIC_READER \\
    --feature BASIC_VIEW --feature BASIC_EXPORT --apply --json

安全规则：只补充缺失功能项，不会移除角色已有权限。`
    )
    .action(async (options: AssignFeatureOptions) => {
      const context = await createContext(store, options);
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

      if (options.apply && addedFeatureIds.length > 0) {
        await context.client.insertRelations(
          "featureRoleFeature",
          roleId,
          addedFeatureIds
        );
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
          verified: options.apply ? verified : addedFeatureIds.length === 0
        },
        options.compact
      );
    });

  const data = permission
    .command("data")
    .description("权限对象、权限类型、数据角色与数据范围");

  data
    .command("inspect")
    .description("汇总权限对象类型、数据权限类型和数据角色")
    .option("--role <code-or-id>", "同时读取指定数据角色包含的权限类型")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission data inspect --json
  eadp permission data inspect --role ORG_ADMIN --json

安全说明：不读取角色已分配的数据值，因为对应查询会自动删除远端失效关系。`
    )
    .action(async (options: InspectOptions) => {
      const context = await createContext(store, options);
      const [authorizeEntityTypes, dataAuthorizeTypes, roleGroups, roles] =
        await Promise.all([
          context.client.findAll("authorizeEntityType"),
          context.client.findAll("dataAuthorizeType"),
          context.client.findAll("dataRoleGroup"),
          context.client.findByPage("dataRole")
        ]);
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

  data
    .command("apply")
    .description("幂等创建或更新一个数据角色；默认只预览")
    .requiredOption("--role-code <code>", "数据角色代码")
    .requiredOption("--role-name <name>", "数据角色名称")
    .requiredOption("--group <code-or-id>", "数据角色组代码、名称或 ID")
    .option("--tenant-code <code>", "租户代码；不提供时由服务端上下文确定")
    .option("--ignore-parent", "忽略上级公共角色")
    .option("--env <name>", "环境名称；默认使用当前环境")
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission data apply --role-code ORG_READER \\
    --role-name 组织只读角色 --group ORG_ROLE --json
  eadp permission data apply --role-code ORG_READER \\
    --role-name 组织只读角色 --group ORG_ROLE --apply --json`
    )
    .action(async (options: ApplyDataRoleOptions) => {
      const context = await createContext(store, options);
      const [groups, roles] = await Promise.all([
        context.client.findAll("dataRoleGroup"),
        context.client.findByPage("dataRole")
      ]);
      const group = selectRecord(groups, options.group, "数据角色组");
      const existing = findRecordByCode(roles, options.roleCode);
      const desired: PermissionRecord = {
        ...(existing ?? {}),
        code: options.roleCode,
        name: options.roleName,
        dataRoleGroupId: recordId(group, "数据角色组"),
        ignoreParent: options.ignoreParent ?? existing?.ignoreParent ?? false,
        ...(options.tenantCode === undefined
          ? {}
          : { tenantCode: options.tenantCode })
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
      const verifiedRole = findRecordByCode(
        await context.client.findByPage("dataRole"),
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
          verified,
          verifiedRole
        },
        options.compact
      );
    });

  data
    .command("assign")
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
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行写入并回查；回查可能清理远端失效关系")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission data assign --role ORG_READER --auth-type ORG \\
    --entity <组织ID> --json
  eadp permission data assign --role ORG_READER --auth-type ORG \\
    --entity <组织ID> --apply --json

预览模式不会读取已分配值。正式执行会先后回查授权值，这些服务端查询可能自动清理
已经不存在的授权关系。insertRelations 本身会去重，重复执行不会产生重复关系。`
    )
    .action(async (options: AssignDataOptions) => {
      const context = await createContext(store, options);
      const [roles, authorizeTypes] = await Promise.all([
        context.client.findByPage("dataRole"),
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
          cleanupMayOccur: true,
          verificationMode: includesChildren ? "server-normalized-tree" : "exact",
          verified
        },
        options.compact
      );
    });

  const principal = permission
    .command("principal")
    .description("把功能角色或数据角色分配给用户、岗位或岗位类别");

  principal
    .command("assign")
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
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行写入；不提供时仅输出差异预览")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission principal assign --subject-type user --subject lin \\
    --role-type functional --role BASIC_READER --json
  eadp permission principal assign --subject-type position --subject FIN_MANAGER \\
    --role-type data --role ORG_READER --apply --json

用户可按 account、员工号或员工姓名匹配；岗位和岗位类别可按 code 匹配。
--subject、--employee-code、--employee-name 三选一。岗位类别只支持功能角色。`
    )
    .action(async (options: AssignPrincipalOptions) => {
      if (options.subjectType === "position-category" && options.roleType === "data") {
        throw new CliError("岗位类别不支持直接分配数据角色");
      }
      const context = await createContext(store, options);
      const subjectResource =
        options.subjectType === "user"
          ? "user"
          : options.subjectType === "position"
            ? "position"
            : "positionCategory";
      const roleResource =
        options.roleType === "functional" ? "featureRole" : "dataRole";
      const relationResource = principalRelationResource(
        options.subjectType,
        options.roleType
      );
      const roles = await context.client.findByPage(roleResource);
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

      if (options.apply && addedRoleIds.length > 0) {
        await context.client.insertRelations(
          relationResource,
          subjectId,
          addedRoleIds
        );
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
          verified: options.apply ? verified : addedRoleIds.length === 0
        },
        options.compact
      );
    });

  principal
    .command("revoke")
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
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--apply", "执行移除；不提供时仅输出差异预览")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission principal revoke --subject-type user --employee-code E1001 \\
    --role-type functional --role BASIC_READER --json
  eadp permission principal revoke --subject-type user --subject lin \\
    --role-type data --role ORG_READER --apply --json

安全规则：默认只预览；只移除明确列出的角色，不影响主体的其他角色。`
    )
    .action(async (options: AssignPrincipalOptions) => {
      if (options.subjectType === "position-category" && options.roleType === "data") {
        throw new CliError("岗位类别不支持直接分配数据角色");
      }
      const context = await createContext(store, options);
      const subjectResource =
        options.subjectType === "user"
          ? "user"
          : options.subjectType === "position"
            ? "position"
            : "positionCategory";
      const roleResource =
        options.roleType === "functional" ? "featureRole" : "dataRole";
      const relationResource = principalRelationResource(
        options.subjectType,
        options.roleType
      );
      const roles = await context.client.findByPage(roleResource);
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

  permission
    .command("verify")
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
    .option("--timeout <ms>", "单次请求超时", "30000")
    .option("--json", "输出稳定的 JSON 数据结构")
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
示例：
  eadp permission verify --user lin --json
  eadp permission verify --employee-code E1001 --json
  eadp permission verify --employee-name 张三 --json
  eadp permission verify --employee-code E1001 --menu 租户管理 --json
  eadp permission verify --user lin --user-id <用户ID> --feature BASIC_VIEW --json
  eadp permission verify --user lin --user-id <用户ID> \\
    --entity-class com.example.Organization --data-feature BASIC_VIEW --json`
    )
    .action(async (options: VerifyOptions) => {
      const context = await createContext(store, options);
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

async function createContext(store: ConfigStore, options: CommonOptions): Promise<{
  environment: string;
  client: PermissionClient;
}> {
  const resolved = resolveEnvironment(await store.load(), options.env);
  return {
    environment: resolved.name,
    client: new PermissionClient({
      baseUrl: resolved.config.baseUrl,
      token: resolved.token,
      timeoutMs: parseTimeout(options.timeout)
    })
  };
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
