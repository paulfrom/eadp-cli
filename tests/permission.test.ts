/**
 * permission 必测矩阵：
 * - functional / data inspect、用户反查
 * - 功能角色 / 数据角色 apply（预览零写入、正式断言请求体、回查、幂等）
 * - assign（feature/data/role）、revoke、copy（assign permission）、verify
 * - 只补差集；重复执行幂等；员工解析歧义零写入；失败立即停止
 */
import { afterEach, describe, expect, it } from "vitest";
import { OperationLogStore } from "../src/operations/store.js";
import {
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

/** permission 命令全部要求非 global 租户。 */
function permissionFixture(): Promise<ReturnType<typeof createFixture>> {
  return createFixture({
    environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
  });
}

type Handler = (context: import("./helpers/index.js").RouteContext) => void | Promise<void>;

function register(server: MockEadpServer, routes: Record<string, Handler>): void {
  for (const [suffix, handler] of Object.entries(routes)) {
    server.onEndsWith(suffix, handler);
  }
}

describe("permission inspect", () => {
  it("inspect functional 汇总应用、功能项、菜单、角色组与授权树", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    register(server, {
      "/appModule/findAll": (context) => context.json([{ id: "app-1", code: "BASIC" }]),
      "/feature/getFeatureTypes": (context) => context.json([{ name: "Operate" }]),
      "/feature/findByAppModuleId": (context) => {
        expect(context.query.get("appModuleId")).toBe("app-1");
        context.json([{ id: "feature-1", code: "BASIC_VIEW", appModuleId: "app-1" }]);
      },
      "/menu/getMenuTree": (context) => context.json([{ id: "menu-1", code: "M1" }]),
      "/featureRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "ROLES" }]),
      "/featureRole/findByPage": (context) => context.json({ rows: [{ id: "role-1", code: "ADMIN" }] }),
      "/featureRoleFeature/getMenuFeatureTree": (context) => {
        expect(context.query.get("featureRoleId")).toBe("role-1");
        context.json([{ id: "menu-1", children: [{ id: "feature-1", authorized: true }] }]);
      },
      "/featureRoleFeature/getAuthorizedMenuRootNodes": (context) => context.json([{ id: "menu-1" }])
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "inspect", "functional", "--app", "BASIC", "--role", "ADMIN"
    ])) as Record<string, unknown>;
    expect(output.kind).toBe("eadp.permission.functional.inspect.v1");
    expect((output.scope as { appModule: Record<string, unknown> }).appModule.id).toBe("app-1");
    expect((output.scope as { role: Record<string, unknown> }).role.id).toBe("role-1");
    expect((output.rolePermissions as { authorizedMenuFeatureTree: unknown[] }).authorizedMenuFeatureTree)
      .toHaveLength(1);
  });

  it("inspect data 汇总数据角色且不读取已分配数据值", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    register(server, {
      "/authorizeEntityType/findAll": (context) => context.json([{ id: "entity-type-1" }]),
      "/dataAuthorizeType/findAll": (context) => context.json([{ id: "auth-type-1", code: "ORG" }]),
      "/dataRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "ORG_ROLE" }]),
      "/dataRole/findByDataRoleGroup": (context) => {
        expect(context.query.get("roleGroupId")).toBe("group-1");
        context.json([{ id: "role-1", code: "ORG_ADMIN" }]);
      },
      "/dataRoleAuthTypeValue/getAuthorizeTypesByRoleId": (context) => {
        expect(context.query.get("roleId")).toBe("role-1");
        context.json([{ id: "auth-type-1" }]);
      }
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "inspect", "data", "--role", "ORG_ADMIN"
    ])) as Record<string, unknown>;
    expect(output.kind).toBe("eadp.permission.data.inspect.v1");
    expect((output.roleAuthorizationTypes as unknown[])).toHaveLength(1);
    expect(server.requests.some((request) => request.path.includes("getAssignedAuthData"))).toBe(false);
  });

  it("inspect users 按功能代码反查拥有最终有效权限的用户", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    const checked: string[] = [];
    register(server, {
      "/feature/findByPage": (context) => context.json({ rows: [{ id: "feature-1", code: "BASIC_VIEW" }] }),
      "/user/findByPage": (context) => context.json({ rows: [
        { id: "user-direct" }, { id: "user-position" }, { id: "user-none" }
      ] }),
      "/user/checkUserFeaturesAuthority": (context) => {
        const body = context.body as { userId: string; featureCodes: string[] };
        expect(body.featureCodes).toEqual(["BASIC_VIEW"]);
        checked.push(body.userId);
        context.json({ BASIC_VIEW: body.userId !== "user-none" });
      }
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "inspect", "users", "--feature", "BASIC_VIEW"
    ])) as {
      kind: string;
      inspectedUserCount: number;
      authorizedUserCount: number;
      users: Array<{ id: string }>;
    };
    expect(output.kind).toBe("eadp.permission.feature-users.inspect.v1");
    expect(output.inspectedUserCount).toBe(3);
    expect(output.authorizedUserCount).toBe(2);
    expect(output.users.map((user) => user.id)).toEqual(["user-direct", "user-position"]);
    expect(checked).toEqual(["user-direct", "user-position", "user-none"]);
  });

  it("global 租户拒绝权限查询（必须使用非 global 租户）", async () => {
    const fixture = await createFixture();
    const error = await runExpectError(fixture.program(), ["permission", "verify", "--user", "lin"]);
    expect(error).toContain("必须使用非 global 租户");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});

describe("permission apply functional-role：六大场景", () => {
  it("预览零写入 → 正式执行断言请求体 → 回查 → 再次执行 unchanged", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    const roles: Array<Record<string, unknown>> = [];
    const saves: unknown[] = [];
    register(server, {
      "/featureRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "BASIC_ROLE" }]),
      "/featureRole/findByPage": (context) => context.json({ rows: roles }),
      "/featureRole/save": (context) => {
        const body = context.body as Record<string, unknown>;
        saves.push(body);
        const saved = { ...body, id: "role-1" };
        roles.push(saved);
        context.json(saved);
      },
      "/featureRole/findByCode": (context) => {
        const code = context.query.get("code");
        context.json(roles.find((role) => role.code === code) ?? null);
      }
    });
    const args = [
      "permission", "apply", "functional-role", "--role-code", "BASIC_READER",
      "--role-name", "基础只读角色", "--group", "BASIC_ROLE"
    ];

    // 场景1 预览
    const preview = JSON.parse(await runCommand(fixture.program(), args)) as {
      applied: boolean;
      action: string;
      desired: Record<string, unknown>;
    };
    expect(preview.applied).toBe(false);
    expect(preview.action).toBe("create");
    expect(preview.desired).toMatchObject({
      code: "BASIC_READER",
      name: "基础只读角色",
      featureRoleGroupId: "group-1",
      roleType: "CanUse",
      tenantCode: "tenant-a"
    });
    expect(saves).toHaveLength(0);

    // 场景2+3 正式执行：断言完整请求体并回查
    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      applied: boolean;
      verified: boolean;
      operationId: string;
    };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.operationId).toEqual(expect.any(String));
    expect(saves).toEqual([{
      code: "BASIC_READER",
      name: "基础只读角色",
      featureRoleGroupId: "group-1",
      roleType: "CanUse",
      ignoreParent: false,
      tenantCode: "tenant-a"
    }]);
    expect(roles).toHaveLength(1);

    // 场景4 再次执行
    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      action: string;
      applied: boolean;
      verified: boolean;
      operationId?: string;
    };
    expect(again.action).toBe("unchanged");
    expect(again.applied).toBe(false);
    expect(again.verified).toBe(true);
    expect(again.operationId).toBeUndefined();
    expect(saves).toHaveLength(1);
  });

  it("场景5 歧义：角色组匹配多条时报错且零写入", async () => {
    const fixture = await permissionFixture();
    const saves: unknown[] = [];
    register(fixture.server("dev"), {
      "/featureRoleGroup/findAll": (context) => context.json([
        { id: "group-1", code: "BASIC_ROLE" },
        { id: "group-2", code: "BASIC_ROLE" }
      ]),
      "/featureRole/findByPage": (context) => context.json({ rows: [] }),
      "/featureRole/save": (context) => {
        saves.push(context.body);
        context.json({ id: "x" });
      }
    });
    const error = await runExpectError(fixture.program(), [
      "permission", "apply", "functional-role", "--role-code", "R", "--role-name", "R", "--group", "BASIC_ROLE"
    ]);
    expect(error).toContain("匹配到多条记录");
    expect(saves).toHaveLength(0);
  });

  it("场景6 失败：save 失败立即停止且不重试", async () => {
    const fixture = await permissionFixture();
    let saveCount = 0;
    register(fixture.server("dev"), {
      "/featureRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "G" }]),
      "/featureRole/findByPage": (context) => context.json({ rows: [] }),
      "/featureRole/save": (context) => {
        saveCount += 1;
        context.fail("boom", 500);
      }
    });
    const error = await runExpectError(fixture.program(), [
      "permission", "apply", "functional-role", "--role-code", "R", "--role-name", "R",
      "--group", "G", "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    expect(saveCount).toBe(1);
  });
});

describe("permission apply data-role", () => {
  it("预览零写入，正式执行创建并回查，再次执行 unchanged", async () => {
    const fixture = await permissionFixture();
    const roles: Array<Record<string, unknown>> = [];
    const saves: unknown[] = [];
    register(fixture.server("dev"), {
      "/dataRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "ORG_ROLE" }]),
      "/dataRole/findByDataRoleGroup": (context) => context.json(roles),
      "/dataRole/save": (context) => {
        const body = context.body as Record<string, unknown>;
        saves.push(body);
        const saved = { ...body, id: "role-1" };
        roles.push(saved);
        context.json(saved);
      }
    });
    const args = [
      "permission", "apply", "data-role", "--role-code", "ORG_READER",
      "--role-name", "组织只读角色", "--group", "ORG_ROLE"
    ];
    const preview = JSON.parse(await runCommand(fixture.program(), args)) as { action: string; applied: boolean };
    expect(preview.action).toBe("create");
    expect(preview.applied).toBe(false);
    expect(saves).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      applied: boolean;
      verified: boolean;
      operationId: string;
    };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.operationId).toEqual(expect.any(String));
    expect(saves).toEqual([{
      code: "ORG_READER",
      name: "组织只读角色",
      dataRoleGroupId: "group-1",
      ignoreParent: false,
      tenantCode: "tenant-a"
    }]);

    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as { action: string };
    expect(again.action).toBe("unchanged");
    expect(saves).toHaveLength(1);
  });
});

describe("permission assign feature：只补差集", () => {
  it("预览显示差集；正式执行只插入缺失功能项；再次执行幂等", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    const assignedIds = new Set(["feature-1"]);
    const inserts: unknown[] = [];
    register(server, {
      "/featureRole/findByPage": (context) => context.json({ rows: [{ id: "role-1", code: "ADMIN" }] }),
      "/feature/findByPage": (context) => context.json({ rows: [
        { id: "feature-1", code: "BASIC_VIEW" },
        { id: "feature-2", code: "BASIC_EDIT" }
      ] }),
      "/featureRoleFeature/getChildrenFromParentId": (context) => {
        expect(context.query.get("parentId")).toBe("role-1");
        context.json([...assignedIds].map((id) => ({ id })));
      },
      "/featureRoleFeature/insertRelations": (context) => {
        const body = context.body as { parentId: string; childIds: string[] };
        inserts.push(body);
        expect(body.parentId).toBe("role-1");
        body.childIds.forEach((id) => assignedIds.add(id));
        context.json(true);
      }
    });
    const args = [
      "permission", "assign", "feature", "--role", "ADMIN",
      "--feature", "BASIC_VIEW", "--feature", "BASIC_EDIT"
    ];

    // 场景1 预览：输出差集，零写入
    const preview = JSON.parse(await runCommand(fixture.program(), args)) as {
      addedFeatureIds: string[];
      alreadyAssignedFeatureIds: string[];
      action: string;
    };
    expect(preview.addedFeatureIds).toEqual(["feature-2"]);
    expect(preview.alreadyAssignedFeatureIds).toEqual(["feature-1"]);
    expect(preview.action).toBe("preview");
    expect(inserts).toHaveLength(0);

    // 场景2+3 正式执行：只插入缺失项并回查
    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      applied: boolean;
      verified: boolean;
      addedFeatureIds: string[];
      operationId: string;
    };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.addedFeatureIds).toEqual(["feature-2"]);
    expect(inserts).toEqual([{ parentId: "role-1", childIds: ["feature-2"] }]);

    // 场景4 再次执行：unchanged 且零写入
    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      action: string;
      applied: boolean;
      verified: boolean;
    };
    expect(again.action).toBe("unchanged");
    expect(again.applied).toBe(false);
    expect(again.verified).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it("场景6 失败：insertRelations 失败立即停止且不重试", async () => {
    const fixture = await permissionFixture();
    let insertCount = 0;
    register(fixture.server("dev"), {
      "/featureRole/findByPage": (context) => context.json({ rows: [{ id: "role-1", code: "ADMIN" }] }),
      "/feature/findByPage": (context) => context.json({ rows: [{ id: "feature-1", code: "BASIC_VIEW" }] }),
      "/featureRoleFeature/getChildrenFromParentId": (context) => context.json([]),
      "/featureRoleFeature/insertRelations": (context) => {
        insertCount += 1;
        context.fail("boom", 500);
      }
    });
    const error = await runExpectError(fixture.program(), [
      "permission", "assign", "feature", "--role", "ADMIN", "--feature", "BASIC_VIEW", "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    expect(insertCount).toBe(1);
  });
});

describe("permission assign data", () => {
  it("预览不读取已分配值；正式执行只插入差集并回查", async () => {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    const assignedIds = new Set(["org-1"]);
    const inserts: unknown[] = [];
    register(server, {
      "/dataRoleGroup/findAll": (context) => context.json([{ id: "group-1", code: "ORG_ROLE" }]),
      "/dataRole/findByDataRoleGroup": (context) => context.json([{ id: "role-1", code: "ORG_READER" }]),
      "/dataAuthorizeType/findAll": (context) => context.json([{ id: "auth-type-1", code: "ORG" }]),
      "/dataRoleAuthTypeValue/getAssignedAuthDatas": (context) => {
        expect(context.query.get("roleId")).toBe("role-1");
        expect(context.query.get("authTypeId")).toBe("auth-type-1");
        context.json([...assignedIds].map((id) => ({ id })));
      },
      "/dataRoleAuthTypeValue/insertRelations": (context) => {
        const body = context.body as { dataRoleId: string; dataAuthorizeTypeId: string; entityIds: string[] };
        inserts.push(body);
        expect(body.dataRoleId).toBe("role-1");
        expect(body.dataAuthorizeTypeId).toBe("auth-type-1");
        body.entityIds.forEach((id) => assignedIds.add(id));
        context.json(true);
      }
    });
    const args = [
      "permission", "assign", "data", "--role", "ORG_READER", "--auth-type", "ORG",
      "--entity", "org-1", "--entity", "org-2"
    ];

    const preview = JSON.parse(await runCommand(fixture.program(), args)) as {
      action: string;
      cleanupMayOccur: boolean;
      requestedEntityIds: string[];
    };
    expect(preview.action).toBe("preview");
    expect(preview.cleanupMayOccur).toBe(false);
    expect(inserts).toHaveLength(0);
    // 预览不触发已分配值读取
    expect(server.requests.some((request) => request.path.includes("getAssignedAuthDatas"))).toBe(false);

    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      applied: boolean;
      verified: boolean;
      addedEntityIds: string[];
      cleanupMayOccur: boolean;
    };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.addedEntityIds).toEqual(["org-2"]);
    expect(applied.cleanupMayOccur).toBe(true);
    expect(inserts).toEqual([{ dataRoleId: "role-1", dataAuthorizeTypeId: "auth-type-1", entityIds: ["org-2"] }]);

    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      action: string;
      applied: boolean;
    };
    expect(again.action).toBe("unchanged");
    expect(again.applied).toBe(false);
    expect(inserts).toHaveLength(1);
  });
});

describe("permission assign role / revoke role", () => {
  it("assign role 给用户补充分配功能角色，重复执行幂等", async () => {
    const fixture = await permissionFixture();
    const assignedIds = new Set(["role-1"]);
    const inserts: unknown[] = [];
    register(fixture.server("dev"), {
      "/user/findByPage": (context) => context.json({ rows: [{ id: "user-1", account: "lin" }] }),
      "/featureRole/findByPage": (context) => context.json({ rows: [
        { id: "role-1", code: "BASIC_READER" },
        { id: "role-2", code: "BASIC_ADMIN" }
      ] }),
      "/userFeatureRole/getChildrenFromParentId": (context) => {
        expect(context.query.get("parentId")).toBe("user-1");
        context.json([...assignedIds].map((id) => ({ id })));
      },
      "/userFeatureRole/insertRelations": (context) => {
        const body = context.body as { parentId: string; childIds: string[] };
        inserts.push(body);
        expect(body.parentId).toBe("user-1");
        body.childIds.forEach((id) => assignedIds.add(id));
        context.json(true);
      }
    });
    const args = [
      "permission", "assign", "role", "--subject-type", "user", "--subject", "lin",
      "--role-type", "functional", "--role", "BASIC_READER", "--role", "BASIC_ADMIN"
    ];
    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      verified: boolean;
      addedRoleIds: string[];
    };
    expect(applied.verified).toBe(true);
    expect(applied.addedRoleIds).toEqual(["role-2"]);
    expect(inserts).toEqual([{ parentId: "user-1", childIds: ["role-2"] }]);

    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      action: string;
      verified: boolean;
    };
    expect(again.action).toBe("unchanged");
    expect(again.verified).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it("revoke role 预览零移除，正式执行移除指定角色并回查", async () => {
    const fixture = await permissionFixture();
    const assignedIds = new Set(["role-1", "role-2"]);
    const removes: unknown[] = [];
    register(fixture.server("dev"), {
      "/employee/findByCode": (context) => context.json({
        id: "user-1", code: "E1001", userName: "张三", userAccount: "zhangsan", tenantCode: "tenant-a"
      }),
      "/featureRole/findByPage": (context) => context.json({ rows: [
        { id: "role-1", code: "BASIC_READER" },
        { id: "role-2", code: "BASIC_ADMIN" }
      ] }),
      "/userFeatureRole/getChildrenFromParentId": (context) => {
        expect(context.query.get("parentId")).toBe("user-1");
        context.json([...assignedIds].map((id) => ({ id })));
      },
      "/userFeatureRole/removeRelations": (context) => {
        const body = context.body as { parentId: string; childIds: string[] };
        removes.push(body);
        expect(body.parentId).toBe("user-1");
        body.childIds.forEach((id) => assignedIds.delete(id));
        context.json(true);
      }
    });
    const args = [
      "permission", "revoke", "role", "--subject-type", "user", "--employee-code", "E1001",
      "--role-type", "functional", "--role", "BASIC_READER"
    ];
    const preview = JSON.parse(await runCommand(fixture.program(), args)) as {
      action: string;
      removedRoleIds: string[];
    };
    expect(preview.action).toBe("preview");
    expect(preview.removedRoleIds).toEqual(["role-1"]);
    expect(removes).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      verified: boolean;
      action: string;
    };
    expect(applied.verified).toBe(true);
    expect(applied.action).toBe("revoked");
    expect(removes).toEqual([{ parentId: "user-1", childIds: ["role-1"] }]);

    const again = JSON.parse(await runCommand(fixture.program(), [...args, "--apply"])) as {
      action: string;
      verified: boolean;
    };
    expect(again.action).toBe("unchanged");
    expect(again.verified).toBe(true);
    expect(removes).toHaveLength(1);
  });

  it("岗位类别不支持直接分配数据角色", async () => {
    const fixture = await permissionFixture();
    const error = await runExpectError(fixture.program(), [
      "permission", "assign", "role", "--subject-type", "position-category",
      "--subject", "PC", "--role-type", "data", "--role", "R"
    ]);
    expect(error).toContain("岗位类别不支持直接分配数据角色");
    expect(fixture.server("dev").requests).toHaveLength(0);
  });
});

describe("permission assign permission（复制权限）", () => {
  async function copyFixture(): Promise<{
    fixture: Awaited<ReturnType<typeof permissionFixture>>;
    writes: unknown[];
    relations: Record<string, Array<Record<string, unknown>>>;
  }> {
    const fixture = await permissionFixture();
    const server = fixture.server("dev");
    const relations: Record<string, Array<Record<string, unknown>>> = {
      "employee-1:userFeatureRole": [{ id: "feature-public", publicUserType: "ALL" }, { id: "feature-1" }],
      "employee-2:userFeatureRole": [{ id: "feature-existing" }],
      "employee-1:userDataRole": [{ id: "data-1" }],
      "employee-2:userDataRole": [],
      "employee-1:employeePosition": [{ id: "position-1" }, { id: "position-2" }],
      "employee-2:employeePosition": [{ id: "position-2" }]
    };
    const writes: unknown[] = [];
    register(server, {
      "/employee/findByCode": (context) => {
        const code = context.query.get("code");
        if (code === "E1001") {
          context.json({ id: "employee-1", code: "E1001", tenantCode: "tenant-a" });
        } else if (code === "E1002") {
          context.json({ id: "employee-2", code: "E1002", tenantCode: "tenant-a" });
        } else {
          context.json(null);
        }
      },
      "/employee/quickSearch": (context) => context.json({ rows: [] }),
      "/userFeatureRole/getChildrenFromParentId": (context) => {
        const parentId = context.query.get("parentId")!;
        context.json(relations[`${parentId}:userFeatureRole`] ?? []);
      },
      "/userDataRole/getChildrenFromParentId": (context) => {
        const parentId = context.query.get("parentId")!;
        context.json(relations[`${parentId}:userDataRole`] ?? []);
      },
      "/employeePosition/getChildrenFromParentId": (context) => {
        const parentId = context.query.get("parentId")!;
        context.json(relations[`${parentId}:employeePosition`] ?? []);
      },
      "/userFeatureRole/insertRelations": (context) => {
        writes.push({ resource: "userFeatureRole", body: context.body });
        const body = context.body as { parentId: string; childIds: string[] };
        relations[`${body.parentId}:userFeatureRole`] = [
          ...(relations[`${body.parentId}:userFeatureRole`] ?? []),
          ...body.childIds.map((id) => ({ id }))
        ];
        context.json(true);
      },
      "/userDataRole/insertRelations": (context) => {
        writes.push({ resource: "userDataRole", body: context.body });
        const body = context.body as { parentId: string; childIds: string[] };
        relations[`${body.parentId}:userDataRole`] = [
          ...(relations[`${body.parentId}:userDataRole`] ?? []),
          ...body.childIds.map((id) => ({ id }))
        ];
        context.json(true);
      },
      "/employeePosition/insertRelations": (context) => {
        writes.push({ resource: "employeePosition", body: context.body });
        const body = context.body as { parentId: string; childIds: string[] };
        relations[`${body.parentId}:employeePosition`] = [
          ...(relations[`${body.parentId}:employeePosition`] ?? []),
          ...body.childIds.map((id) => ({ id }))
        ];
        context.json(true);
      }
    });
    return { fixture, writes, relations };
  }

  it("预览输出差集（含公共角色跳过）且零写入", async () => {
    const { fixture } = await copyFixture();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "assign", "permission",
      "--source-employee-code", "E1001", "--target-employee-code", "E1002"
    ])) as {
      action: string;
      requested: Record<string, Array<Record<string, unknown>>>;
      skippedPublic: Record<string, Array<Record<string, unknown>>>;
      alreadyAssigned: Record<string, Array<Record<string, unknown>>>;
      added: Record<string, Array<Record<string, unknown>>>;
    };
    expect(output.action).toBe("preview");
    expect(output.requested.functionalRoles.map((role) => role.id)).toEqual(["feature-public", "feature-1"]);
    expect(output.skippedPublic.functionalRoles.map((role) => role.id)).toEqual(["feature-public"]);
    expect(output.added.functionalRoles.map((role) => role.id)).toEqual(["feature-1"]);
    expect(output.added.dataRoles.map((role) => role.id)).toEqual(["data-1"]);
    expect(output.added.positions.map((role) => role.id)).toEqual(["position-1"]);
    expect(output.alreadyAssigned.positions.map((role) => role.id)).toEqual(["position-2"]);
  });

  it("正式执行只写差集并回查；再次执行 unchanged；失败立即停止", async () => {
    const { fixture, writes } = await copyFixture();
    const args = [
      "permission", "assign", "permission",
      "--source-employee-code", "E1001", "--target-employee-code", "E1002", "--apply"
    ];
    const applied = JSON.parse(await runCommand(fixture.program(), args)) as {
      verified: boolean;
      action: string;
      operationId: string;
    };
    expect(applied.verified).toBe(true);
    expect(applied.action).toBe("assigned");
    expect(applied.operationId).toEqual(expect.any(String));
    // 只补差集，且按 functional → data → position 顺序写入
    expect(writes).toEqual([
      { resource: "userFeatureRole", body: { parentId: "employee-2", childIds: ["feature-1"] } },
      { resource: "userDataRole", body: { parentId: "employee-2", childIds: ["data-1"] } },
      { resource: "employeePosition", body: { parentId: "employee-2", childIds: ["position-1"] } }
    ]);
    const record = await new OperationLogStore(fixture.store.directory).load(applied.operationId);
    expect(record.actions.map((action) => action.resource)).toEqual([
      "userFeatureRole", "userDataRole", "employeePosition"
    ]);

    const again = JSON.parse(await runCommand(fixture.program(), args)) as {
      action: string;
      applied: boolean;
      verified: boolean;
    };
    expect(again.action).toBe("unchanged");
    expect(again.applied).toBe(false);
    expect(again.verified).toBe(true);
    expect(writes).toHaveLength(3);
  });

  it("员工姓名重名时零写入；源目标相同员工时报错", async () => {
    const fixture = await permissionFixture();
    const writes: unknown[] = [];
    register(fixture.server("dev"), {
      "/employee/quickSearch": (context) => context.json({ rows: [
        { id: "employee-1", code: "E1001", userAccount: "one", userName: "重名员工" },
        { id: "employee-2", code: "E1002", userAccount: "two", userName: "重名员工" }
      ] }),
      "/employee/findByCode": (context) => context.json({ id: "employee-1", code: "E1001", tenantCode: "tenant-a" }),
      "/userFeatureRole/insertRelations": (context) => {
        writes.push(context.body);
        context.json(true);
      }
    });
    const error = await runExpectError(fixture.program(), [
      "permission", "assign", "permission",
      "--source-employee-name", "重名员工", "--target-employee-code", "E1002"
    ]);
    expect(error).toContain("源员工姓名存在重名");
    expect(writes).toHaveLength(0);

    const same = await runExpectError(fixture.program(), [
      "permission", "assign", "permission",
      "--source-employee-code", "E1001", "--target-employee-code", "E1001"
    ]);
    expect(same).toContain("源员工和目标员工不能相同");
    expect(writes).toHaveLength(0);
  });

  it("copy 中途失败立即停止，不重试、不继续后续写入", async () => {
    const fixture = await permissionFixture();
    const writes: unknown[] = [];
    let userDataRoleCalls = 0;
    register(fixture.server("dev"), {
      "/employee/findByCode": (context) => {
        const code = context.query.get("code");
        context.json(code === "E1002"
          ? { id: "employee-2", code: "E1002", tenantCode: "tenant-a" }
          : { id: "employee-1", code: "E1001", tenantCode: "tenant-a" });
      },
      "/userFeatureRole/getChildrenFromParentId": (context) => {
        context.json(context.query.get("parentId") === "employee-2" ? [] : [{ id: "feature-1" }]);
      },
      "/userDataRole/getChildrenFromParentId": (context) => {
        context.json(context.query.get("parentId") === "employee-2" ? [] : [{ id: "data-1" }]);
      },
      "/employeePosition/getChildrenFromParentId": (context) => {
        context.json(context.query.get("parentId") === "employee-2" ? [] : [{ id: "position-1" }]);
      },
      "/userFeatureRole/insertRelations": (context) => {
        writes.push({ resource: "userFeatureRole" });
        context.json(true);
      },
      "/userDataRole/insertRelations": (context) => {
        userDataRoleCalls += 1;
        writes.push({ resource: "userDataRole" });
        context.fail("boom", 500);
      },
      "/employeePosition/insertRelations": (context) => {
        writes.push({ resource: "employeePosition" });
        context.json(true);
      }
    });
    const error = await runExpectError(fixture.program(), [
      "permission", "assign", "permission",
      "--source-employee-code", "E1001", "--target-employee-code", "E1002", "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    expect(userDataRoleCalls).toBe(1);
    expect(writes.map((item) => (item as { resource: string }).resource))
      .toEqual(["userFeatureRole", "userDataRole"]);
  });
});

describe("permission verify", () => {
  it("按账号校验功能与数据范围", async () => {
    const fixture = await permissionFixture();
    register(fixture.server("dev"), {
      "/user/getFeatureRolesByAccount": (context) => {
        expect(context.query.get("account")).toBe("lin");
        expect(context.query.get("includeProject")).toBe("true");
        context.json([{ id: "feature-role-1", code: "ADMIN" }]);
      },
      "/user/getDataRolesByAccount": (context) => context.json([{ id: "data-role-1", code: "ORG_ADMIN" }]),
      "/user/checkUserFeaturesAuthority": (context) => {
        const body = context.body as { userId: string; featureCodes: string[] };
        expect(body.userId).toBe("user-1");
        expect(body.featureCodes).toEqual(["BASIC_VIEW", "BASIC_EDIT"]);
        context.json({ BASIC_VIEW: true, BASIC_EDIT: false });
      },
      "/user/getNormalUserAuthorizedEntities": (context) => {
        expect(context.query.get("userId")).toBe("user-1");
        expect(context.query.get("entityClassName")).toBe("com.example.Organization");
        context.json(["org-1", "org-2"]);
      }
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "verify", "--user", "lin", "--user-id", "user-1",
      "--feature", "BASIC_VIEW", "--feature", "BASIC_EDIT",
      "--entity-class", "com.example.Organization", "--data-feature", "BASIC_VIEW"
    ])) as {
      kind: string;
      featureChecks: Record<string, boolean>;
      authorizedEntityIds: string[];
      featureRoles: Array<{ code: string }>;
    };
    expect(output.kind).toBe("eadp.permission.verify.v1");
    expect(output.featureChecks).toEqual({ BASIC_VIEW: true, BASIC_EDIT: false });
    expect(output.authorizedEntityIds).toEqual(["org-1", "org-2"]);
    expect(output.featureRoles[0]!.code).toBe("ADMIN");
  });

  it("按员工号解析用户并校验菜单权限", async () => {
    const fixture = await permissionFixture();
    register(fixture.server("dev"), {
      "/employee/findByCode": (context) => context.json({
        id: "user-1", code: "20017267", userName: "张三", userAccount: "zhangsan"
      }),
      "/user/getFeatureRolesByAccount": (context) => context.json([{ id: "role-1", code: "BASIC_READER" }]),
      "/user/getDataRolesByAccount": (context) => context.json([]),
      "/menu/getMenuTree": (context) => context.json([{
        id: "menu-root", code: "ROOT", name: "根", children: [{
          id: "menu-tenant", code: "TENANT_MANAGEMENT", name: "租户管理",
          featureCode: "TENANT_VIEW", children: []
        }]
      }]),
      "/user/checkUserFeaturesAuthority": (context) => context.json({ TENANT_VIEW: true })
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "permission", "verify", "--employee-code", "20017267", "--menu", "租户管理"
    ])) as {
      user: { account: string; userId: string; employeeCode: string; employeeName: string };
      menuChecks: Array<{ selector: string; authorized: boolean; featureCodes: string[] }>;
    };
    expect(output.user).toEqual({
      account: "zhangsan", userId: "user-1", employeeCode: "20017267", employeeName: "张三"
    });
    expect(output.menuChecks).toEqual([
      expect.objectContaining({ selector: "租户管理", authorized: true, featureCodes: ["TENANT_VIEW"] })
    ]);
  });

  it("按账号校验功能时缺少 --user-id 报错且零请求", async () => {
    const fixture = await permissionFixture();
    const error = await runExpectError(fixture.program(), [
      "permission", "verify", "--user", "lin", "--feature", "BASIC_VIEW"
    ]);
    expect(error).toContain("必须提供 --user-id");
    expect(fixture.server("dev").requests).toHaveLength(0);
  });
});
