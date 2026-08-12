import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { ConfigStore } from "../src/config/store.js";
import { OperationLogStore } from "../src/operations/store.js";

const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("统一权限命令", () => {
  it("按功能代码反查拥有最终有效权限的用户", async () => {
    const checkedUserIds: string[] = [];
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/feature/findByPage")) {
        respond(response, {
          rows: [{ id: "feature-1", code: "BASIC_VIEW", name: "查看" }]
        });
        return;
      }
      if (url.pathname.endsWith("/user/findByPage")) {
        respond(response, {
          rows: [
            { id: "user-direct", account: "direct", userName: "直接用户" },
            { id: "user-position", account: "position", userName: "岗位用户" },
            { id: "user-none", account: "none", userName: "无权限用户" }
          ]
        });
        return;
      }
      if (url.pathname.endsWith("/user/checkUserFeaturesAuthority")) {
        const body = (await readBody(request)) as {
          userId: string;
          featureCodes: string[];
        };
        checkedUserIds.push(body.userId);
        expect(body.featureCodes).toEqual(["BASIC_VIEW"]);
        respond(response, {
          BASIC_VIEW: body.userId !== "user-none"
        });
        return;
      }
      respond(response, undefined, 404);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["inspect", "permission", "users", "--feature", "BASIC_VIEW"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.permission.feature-users.inspect.v1");
    expect(result.feature.code).toBe("BASIC_VIEW");
    expect(result.users.map((user: Record<string, unknown>) => user.id)).toEqual([
      "user-direct",
      "user-position"
    ]);
    expect(result.inspectedUserCount).toBe(3);
    expect(result.authorizedUserCount).toBe(2);
    expect(checkedUserIds).toEqual(["user-direct", "user-position", "user-none"]);
  });

  it("global 环境不能执行权限查询或配置", async () => {
    const { store } = await createFixtureServer((_request, response) =>
      respond(response, undefined, 404)
    );
    await store.update((config) => {
      config.environments.dev!.tenantCode = "global";
    });

    await expect(
      createProgram(store).parseAsync(
        ["verify", "--user", "lin"],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用非 global 租户");
  });

  it("functional inspect 汇总功能权限配置并按角色读取授权树", async () => {
    const requestedPaths: string[] = [];
    const { store } = await createFixtureServer((request, response) => {
      requestedPaths.push(new URL(request.url ?? "/", "http://localhost").pathname);
      expect(request.headers["x-api-token"]).toBe("secret");
      const path = requestedPaths.at(-1)!;
      const dataByPath: Record<string, unknown> = {
        "/api-gateway/sei-basic/appModule/findAll": [
          { id: "app-1", code: "BASIC", name: "基础应用" }
        ],
        "/api-gateway/sei-basic/feature/getFeatureTypes": [
          { name: "Operate", description: "操作" }
        ],
        "/api-gateway/sei-basic/feature/findByAppModuleId": [
          { id: "feature-1", code: "BASIC_VIEW", appModuleId: "app-1" }
        ],
        "/api-gateway/sei-basic/menu/getMenuTree": [
          { id: "menu-1", name: "基础配置" }
        ],
        "/api-gateway/sei-basic/featureRoleGroup/findAll": [
          { id: "group-1", code: "BASIC_ROLE", name: "基础角色" }
        ],
        "/api-gateway/sei-basic/featureRole/findByPage": {
          rows: [{ id: "role-1", code: "ADMIN", name: "管理员" }]
        },
        "/api-gateway/sei-basic/featureRoleFeature/getMenuFeatureTree": [
          { id: "menu-1", children: [{ id: "feature-1", authorized: true }] }
        ],
        "/api-gateway/sei-basic/featureRoleFeature/getAuthorizedMenuRootNodes": [
          { id: "menu-1", name: "基础配置" }
        ]
      };
      respond(response, dataByPath[path]);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "inspect",
        "permission",
        "functional",
        "--app",
        "BASIC",
        "--role",
        "ADMIN"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.permission.functional.inspect.v1");
    expect(result.scope.appModule.id).toBe("app-1");
    expect(result.scope.role.id).toBe("role-1");
    expect(result.features).toHaveLength(1);
    expect(result.rolePermissions.authorizedMenuFeatureTree).toHaveLength(1);
    expect(requestedPaths).toContain(
      "/api-gateway/sei-basic/featureRoleFeature/getMenuFeatureTree"
    );
  });

  it("data inspect 不调用具有自动清理副作用的已分配值接口", async () => {
    const requestedPaths: string[] = [];
    const { store } = await createFixtureServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requestedPaths.push(path);
      const dataByPath: Record<string, unknown> = {
        "/api-gateway/sei-basic/authorizeEntityType/findAll": [
          { id: "entity-type-1", name: "组织机构" }
        ],
        "/api-gateway/sei-basic/dataAuthorizeType/findAll": [
          { id: "auth-type-1", code: "ORG", name: "组织权限" }
        ],
        "/api-gateway/sei-basic/dataRoleGroup/findAll": [
          { id: "group-1", code: "ORG_ROLE", name: "组织角色" }
        ],
        "/api-gateway/sei-basic/dataRole/findByPage": {
          rows: [{ id: "role-1", code: "ORG_ADMIN", name: "组织管理员" }]
        },
        "/api-gateway/sei-basic/dataRoleAuthTypeValue/getAuthorizeTypesByRoleId": [
          { id: "auth-type-1", code: "ORG", name: "组织权限" }
        ]
      };
      respond(response, dataByPath[path]);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["inspect", "permission", "data", "--role", "ORG_ADMIN"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.permission.data.inspect.v1");
    expect(result.roleAuthorizationTypes).toHaveLength(1);
    expect(result.warnings[0]).toContain("未读取已分配数据值");
    expect(
      requestedPaths.some((path) => path.includes("getAssignedAuthData"))
    ).toBe(false);
  });

  it("verify 按账号返回角色并校验指定功能和数据范围", async () => {
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/getFeatureRolesByAccount")) {
        expect(url.searchParams.get("account")).toBe("lin");
        respond(response, [{ id: "feature-role-1", code: "ADMIN" }]);
        return;
      }
      if (url.pathname.endsWith("/getDataRolesByAccount")) {
        respond(response, [{ id: "data-role-1", code: "ORG_ADMIN" }]);
        return;
      }
      if (url.pathname.endsWith("/checkUserFeaturesAuthority")) {
        expect(await readBody(request)).toEqual({
          userId: "user-1",
          featureCodes: ["BASIC_VIEW", "BASIC_EDIT"]
        });
        respond(response, { BASIC_VIEW: true, BASIC_EDIT: false });
        return;
      }
      if (url.pathname.endsWith("/getNormalUserAuthorizedEntities")) {
        expect(url.searchParams.get("entityClassName")).toBe(
          "com.example.Organization"
        );
        expect(url.searchParams.get("userId")).toBe("user-1");
        respond(response, ["org-1", "org-2"]);
        return;
      }
      respond(response, undefined, 404);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "verify",
        "--user",
        "lin",
        "--user-id",
        "user-1",
        "--feature",
        "BASIC_VIEW",
        "--feature",
        "BASIC_EDIT",
        "--entity-class",
        "com.example.Organization",
        "--data-feature",
        "BASIC_VIEW"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.kind).toBe("eadp.permission.verify.v1");
    expect(result.featureChecks).toEqual({
      BASIC_VIEW: true,
      BASIC_EDIT: false
    });
    expect(result.authorizedEntityIds).toEqual(["org-1", "org-2"]);
  });

  it("functional apply 默认只预览，--apply 后幂等创建并回查功能角色", async () => {
    const roles: Array<Record<string, unknown>> = [];
    let saveCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/featureRoleGroup/findAll")) {
        respond(response, [{ id: "group-1", code: "BASIC_ROLE", name: "基础角色" }]);
        return;
      }
      if (url.pathname.endsWith("/featureRole/findByPage")) {
        respond(response, { rows: roles });
        return;
      }
      if (url.pathname.endsWith("/featureRole/save")) {
        saveCount += 1;
        const body = (await readBody(request)) as Record<string, unknown>;
        const saved = { ...body, id: "role-1" };
        roles.push(saved);
        respond(response, saved);
        return;
      }
      if (url.pathname.endsWith("/featureRole/findByCode")) {
        respond(response, roles.find((role) => role.code === url.searchParams.get("code")));
        return;
      }
      respond(response, undefined, 404);
    });

    const previewOutput = captureOutput();
    const args = [
      "apply",
      "functional-role",
      "--role-code",
      "BASIC_READER",
      "--role-name",
      "基础只读角色",
      "--group",
      "BASIC_ROLE"
    ];
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(JSON.parse(previewOutput.text()).action).toBe("create");
    expect(saveCount).toBe(0);
    vi.restoreAllMocks();

    const applyOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    const applied = JSON.parse(applyOutput.text());
    expect(applied.verified).toBe(true);
    expect(applied.operationId).toEqual(expect.any(String));
    await expect(new OperationLogStore(store.directory).load(applied.operationId)).resolves.toMatchObject({
      environment: "dev",
      status: "completed",
      actions: [expect.objectContaining({
        type: "create-entity",
        resource: "featureRole",
        entityId: "role-1"
      })]
    });
    expect(saveCount).toBe(1);
    vi.restoreAllMocks();

    captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    expect(saveCount).toBe(1);
  });

  it("feature apply 默认预览，正式创建后回查并返回可回滚 operationId；重复 code 只查 code 即跳过", async () => {
    const features: Array<Record<string, unknown>> = [];
    const requestedPaths: string[] = [];
    const requestedMethods: string[] = [];
    let savedPayload: Record<string, unknown> | undefined;
    let saveCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requestedPaths.push(url.pathname);
      requestedMethods.push(request.method ?? "");
      if (url.pathname.endsWith("/appModule/findAll")) {
        respond(response, [{ id: "app-1", code: "BASIC", name: "基础应用" }]);
        return;
      }
      if (url.pathname.endsWith("/featureGroup/findAll")) {
        respond(response, [
          { id: "group-1", code: "BASIC_DATA", name: "基础数据", appModuleId: "app-1" }
        ]);
        return;
      }
      if (url.pathname.endsWith("/feature/save")) {
        saveCount += 1;
        const body = (await readBody(request)) as Record<string, unknown>;
        savedPayload = body;
        const saved = {
          ...body,
          ...(typeof body.url === "string"
            ? { url: body.url.replace(/^\/+|\/+$/g, "") }
            : {}),
          id: "feature-1"
        };
        features.push(saved);
        respond(response, saved);
        return;
      }
      if (url.pathname.endsWith("/feature/findByCode")) {
        respond(
          response,
          features.find((feature) => feature.code === url.searchParams.get("code")) ?? null
        );
        return;
      }
      if (url.pathname.endsWith("/feature/findOne")) {
        respond(
          response,
          features.find((feature) => feature.id === url.searchParams.get("id")) ?? null
        );
        return;
      }
      if (url.pathname.endsWith("/feature/delete/feature-1")) {
        features.splice(0, features.length);
        respond(response, true);
        return;
      }
      respond(response, undefined, 404);
    });
    await store.update((config) => {
      config.environments.dev!.tenantCode = "global";
    });

    const args = [
      "apply",
      "feature",
      "--code",
      "BASIC_VIEW",
      "--name",
      "查看基础数据",
      "--app",
      "BASIC",
      "--group",
      "BASIC_DATA",
      "--feature-type",
      "Page",
      "--group-code",
      "/basic",
      "--url",
      "//basic/view///",
      "--can-menu"
    ];
    const previewOutput = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    const preview = JSON.parse(previewOutput.text());
    expect(preview.action).toBe("create");
    expect(preview.applied).toBe(false);
    expect(preview.desired).toMatchObject({
      code: "BASIC_VIEW",
      appModuleId: "app-1",
      featureGroupId: "group-1",
      featureType: "Page",
      canMenu: true,
      tenantCanUse: true,
      mobileUse: false
    });
    expect(preview.desired.url).toBe("/basic/view");
    expect(saveCount).toBe(0);
    vi.restoreAllMocks();

    const tenantDisabledOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--no-tenant-can-use"], { from: "user" });
    const tenantDisabled = JSON.parse(tenantDisabledOutput.text());
    expect(tenantDisabled.desired.tenantCanUse).toBe(false);
    expect(saveCount).toBe(0);
    vi.restoreAllMocks();

    const applyOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    const applied = JSON.parse(applyOutput.text());
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.operationId).toEqual(expect.any(String));
    expect(savedPayload).toMatchObject({
      url: "/basic/view",
      tenantCanUse: true
    });
    await expect(new OperationLogStore(store.directory).load(applied.operationId)).resolves.toMatchObject({
      environment: "dev",
      status: "completed",
      actions: [expect.objectContaining({
        type: "create-entity",
        resource: "feature",
        entityId: "feature-1",
        expected: expect.objectContaining({
          url: "/basic/view",
          tenantCanUse: true
        })
      })]
    });
    expect(saveCount).toBe(1);
    vi.restoreAllMocks();

    const rootUrlOutput = captureOutput();
    await createProgram(store).parseAsync(
      [
        ...args,
        "--code",
        "BASIC_ROOT",
        "--name",
        "根路径",
        "--url",
        "///"
      ],
      { from: "user" }
    );
    const rootUrlPreview = JSON.parse(rootUrlOutput.text());
    expect(rootUrlPreview.desired.url).toBe("/");
    expect(saveCount).toBe(1);
    vi.restoreAllMocks();

    requestedPaths.length = 0;
    requestedMethods.length = 0;
    const unchangedOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    const unchanged = JSON.parse(unchangedOutput.text());
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.applied).toBe(false);
    expect(unchanged.operationId).toBeUndefined();
    expect(saveCount).toBe(1);
    expect(requestedPaths).toEqual([
      "/api-gateway/sei-basic/feature/findByCode"
    ]);
    expect(requestedMethods).toEqual(["GET"]);

    const rollbackOutput = captureOutput();
    await createProgram(store).parseAsync(
      ["rollback", applied.operationId],
      { from: "user" }
    );
    const rollback = JSON.parse(rollbackOutput.text());
    expect(rollback).toMatchObject({
      operationId: applied.operationId,
      status: "rolled-back",
      rolledBack: 1,
      verified: true
    });
    expect(features).toHaveLength(0);
    expect(requestedPaths.filter((path) => path.endsWith("/feature/findOne"))).toHaveLength(2);
    expect(
      requestedPaths.some((path, index) =>
        path.endsWith("/feature/delete/feature-1") && requestedMethods[index] === "DELETE"
      )
    ).toBe(true);
  });

  it("feature apply Business 类型的 --can-menu 会按后端规范化为 false 并通过回查", async () => {
    const features: Array<Record<string, unknown>> = [];
    let savedPayload: Record<string, unknown> | undefined;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/appModule/findAll")) {
        respond(response, [{ id: "app-1", code: "BASIC", name: "基础应用" }]);
        return;
      }
      if (url.pathname.endsWith("/featureGroup/findAll")) {
        respond(response, []);
        return;
      }
      if (url.pathname.endsWith("/feature/save")) {
        const body = (await readBody(request)) as Record<string, unknown>;
        savedPayload = body;
        const saved = {
          ...body,
          canMenu: body.featureType === "Business" ? false : body.canMenu,
          ...(typeof body.url === "string"
            ? { url: body.url.replace(/^\/+|\/+$/g, "") }
            : {}),
          id: "feature-business-1"
        };
        features.push(saved);
        respond(response, saved);
        return;
      }
      if (url.pathname.endsWith("/feature/findByCode")) {
        respond(
          response,
          features.find((feature) => feature.code === url.searchParams.get("code")) ?? null
        );
        return;
      }
      respond(response, undefined, 404);
    });
    await store.update((config) => {
      config.environments.dev!.tenantCode = "global";
    });

    const output = captureOutput();
    await createProgram(store).parseAsync(
      [
        "apply",
        "feature",
        "--code",
        "BASIC_EXPORT",
        "--name",
        "导出基础数据",
        "--app",
        "BASIC",
        "--feature-type",
        "Business",
        "--url",
        "/basic/export/",
        "--can-menu",
        "--apply"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.desired).toMatchObject({
      featureType: "Business",
      canMenu: false,
      url: "/basic/export"
    });
    expect(savedPayload).toMatchObject({
      featureType: "Business",
      canMenu: false,
      url: "/basic/export"
    });
    expect(result.verifiedFeature).toMatchObject({
      featureType: "Business",
      canMenu: false,
      url: "basic/export"
    });
  });

  it("Page feature 缺少或传入空白 --url 时立即失败且不发起远端请求", async () => {
    const requestedPaths: string[] = [];
    const { store } = await createFixtureServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requestedPaths.push(path);
      respond(response, undefined, 500);
    });
    await store.update((config) => {
      config.environments.dev!.tenantCode = "global";
    });

    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "feature",
          "--code",
          "BASIC_VIEW",
          "--name",
          "查看",
          "--app",
          "BASIC",
          "--feature-type",
          "Page"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("Page 类型功能项必须显式提供非空 --url");
    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "feature",
          "--code",
          "BASIC_VIEW",
          "--name",
          "查看",
          "--app",
          "BASIC",
          "--feature-type",
          "Page",
          "--url",
          "   "
        ],
        { from: "user" }
      )
    ).rejects.toThrow("Page 类型功能项必须显式提供非空 --url");
    expect(requestedPaths).toEqual([]);
  });

  it("feature apply 拒绝歧义的应用模块且不保存", async () => {
    let saveCount = 0;
    const { store } = await createFixtureServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path.endsWith("/appModule/findAll")) {
        respond(response, [
          { id: "app-1", code: "BASIC", name: "基础应用" },
          { id: "app-2", code: "BASIC", name: "另一个基础应用" }
        ]);
        return;
      }
      if (path.endsWith("/featureGroup/findAll")) {
        respond(response, []);
        return;
      }
      if (path.endsWith("/feature/findByCode")) {
        respond(response, null);
        return;
      }
      if (path.endsWith("/feature/save")) {
        saveCount += 1;
        respond(response, { id: "unexpected" });
        return;
      }
      respond(response, undefined, 404);
    });
    await store.update((config) => {
      config.environments.dev!.tenantCode = "global";
    });
    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "feature",
          "--code",
          "BASIC_VIEW",
          "--name",
          "查看",
          "--app",
          "BASIC",
          "--feature-type",
          "Page",
          "--url",
          "/basic/view"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("应用模块匹配到多条记录");
    expect(saveCount).toBe(0);
  });

  it("feature apply 拒绝功能项组不存在、歧义或跨应用，并且不保存", async () => {
    const run = async (
      groups: Array<Record<string, unknown>>,
      groupSelector: string,
      expectedError: string
    ): Promise<void> => {
      let saveCount = 0;
      const { store } = await createFixtureServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path.endsWith("/appModule/findAll")) {
          respond(response, [{ id: "app-1", code: "BASIC", name: "基础应用" }]);
          return;
        }
        if (path.endsWith("/featureGroup/findAll")) {
          respond(response, groups);
          return;
        }
        if (path.endsWith("/feature/findByCode")) {
          respond(response, null);
          return;
        }
        if (path.endsWith("/feature/save")) {
          saveCount += 1;
          respond(response, { id: "unexpected" });
          return;
        }
        respond(response, undefined, 404);
      });
      await store.update((config) => {
        config.environments.dev!.tenantCode = "global";
      });
      await expect(
        createProgram(store).parseAsync(
          [
            "apply",
            "feature",
            "--code",
            "BASIC_VIEW",
            "--name",
            "查看",
            "--app",
            "BASIC",
            "--group",
            groupSelector,
            "--feature-type",
            "Page",
            "--url",
            "/basic/view"
          ],
          { from: "user" }
        )
      ).rejects.toThrow(expectedError);
      expect(saveCount).toBe(0);
    };

    await run([], "MISSING_GROUP", "功能项组不存在");
    await run(
      [
        { id: "group-1", code: "BASIC_DATA", name: "基础数据", appModuleId: "app-1" },
        { id: "group-2", code: "BASIC_DATA", name: "另一个基础数据", appModuleId: "app-1" }
      ],
      "BASIC_DATA",
      "功能项组匹配到多条记录"
    );
    await run(
      [{ id: "group-1", code: "BASIC_DATA", name: "基础数据", appModuleId: "app-2" }],
      "BASIC_DATA",
      "功能项组与应用模块不一致"
    );
  });

  it("feature apply 只接受合法功能项类型且必须使用 global 租户", async () => {
    const { store } = await createFixtureServer((_request, response) =>
      respond(response, undefined, 404)
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "feature",
          "--code",
          "BASIC_VIEW",
          "--name",
          "查看",
          "--app",
          "BASIC",
          "--feature-type",
          "Invalid"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("exit 1");
    exitSpy.mockRestore();
    await expect(
      createProgram(store).parseAsync(
        [
          "apply",
          "feature",
          "--code",
          "BASIC_VIEW",
          "--name",
          "查看",
          "--app",
          "BASIC",
          "--feature-type",
          "Page",
          "--url",
          "/basic/view"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("必须使用 global 租户");
    stderrSpy.mockRestore();
  });

  it("functional assign 只补充缺失功能项并在写入后回查", async () => {
    const assignedIds = new Set(["feature-1"]);
    let insertCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/featureRole/findByPage")) {
        respond(response, {
          rows: [{ id: "role-1", code: "ADMIN", name: "管理员" }]
        });
        return;
      }
      if (url.pathname.endsWith("/feature/findByPage")) {
        respond(response, {
          rows: [
            { id: "feature-1", code: "BASIC_VIEW", name: "查看" },
            { id: "feature-2", code: "BASIC_EDIT", name: "编辑" }
          ]
        });
        return;
      }
      if (url.pathname.endsWith("/featureRoleFeature/getChildrenFromParentId")) {
        respond(
          response,
          [...assignedIds].map((id) => ({
            id,
            code: id === "feature-1" ? "BASIC_VIEW" : "BASIC_EDIT"
          }))
        );
        return;
      }
      if (url.pathname.endsWith("/featureRoleFeature/insertRelations")) {
        insertCount += 1;
        const body = (await readBody(request)) as {
          parentId: string;
          childIds: string[];
        };
        expect(body.parentId).toBe("role-1");
        body.childIds.forEach((id) => assignedIds.add(id));
        respond(response, "ok");
        return;
      }
      respond(response, undefined, 404);
    });
    const output = captureOutput();
    const args = [
      "assign",
      "feature",
      "--role",
      "ADMIN",
      "--feature",
      "BASIC_VIEW",
      "--feature",
      "BASIC_EDIT",
      "--apply"
    ];

    await createProgram(store).parseAsync(args, { from: "user" });
    const result = JSON.parse(output.text());
    expect(result.addedFeatureIds).toEqual(["feature-2"]);
    expect(result.verified).toBe(true);
    expect(insertCount).toBe(1);
    vi.restoreAllMocks();

    captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(insertCount).toBe(1);
  });

  it("permission copy 预览三类直接关系、跳过公共角色且不写入", async () => {
    const writes: string[] = [];
    const { store } = await createPermissionCopyFixtureServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname.endsWith("/employee/findByCode")) {
          const employee = url.searchParams.get("code") === "E1001"
            ? { id: "employee-1", code: "E1001", userName: "源员工", tenantCode: "tenant-a" }
            : { id: "employee-2", code: "E1002", userName: "目标员工", tenantCode: "tenant-a" };
          respond(response, employee);
          return;
        }
        if (url.pathname.endsWith("/userFeatureRole/getChildrenFromParentId")) {
          const source = url.searchParams.get("parentId") === "employee-1";
          respond(response, source
            ? [
                { id: "feature-public", code: "PUBLIC", publicUserType: "ALL" },
                { id: "feature-1", code: "FUNC_1" }
              ]
            : [{ id: "feature-existing", code: "FUNC_EXISTING" }]);
          return;
        }
        if (url.pathname.endsWith("/userDataRole/getChildrenFromParentId")) {
          const source = url.searchParams.get("parentId") === "employee-1";
          respond(response, source
            ? [{ id: "data-1", code: "DATA_1" }]
            : []);
          return;
        }
        if (url.pathname.endsWith("/employeePosition/getChildrenFromParentId")) {
          const source = url.searchParams.get("parentId") === "employee-1";
          respond(response, source
            ? [{ id: "position-1", code: "POSITION_1" }, { id: "position-2", code: "POSITION_2" }]
            : [{ id: "position-2", code: "POSITION_2" }]);
          return;
        }
        if (url.pathname.endsWith("/insertRelations")) {
          writes.push(url.pathname);
          respond(response, "unexpected", 500);
          return;
        }
        respond(response, undefined, 404);
      }
    );
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "assign",
        "permission",
        "--source-employee-code",
        "E1001",
        "--target-employee-code",
        "E1002"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.action).toBe("preview");
    expect(result.requested.functionalRoles.map((item: Record<string, unknown>) => item.id)).toEqual([
      "feature-public",
      "feature-1"
    ]);
    expect(result.skippedPublic.functionalRoles.map((item: Record<string, unknown>) => item.id)).toEqual([
      "feature-public"
    ]);
    expect(result.alreadyAssigned.functionalRoles.map((item: Record<string, unknown>) => item.id)).toEqual([]);
    expect(result.added).toMatchObject({
      functionalRoles: [{ id: "feature-1" }],
      dataRoles: [{ id: "data-1" }],
      positions: [{ id: "position-1" }]
    });
    expect(result.counts).toMatchObject({
      functionalRoles: { skippedPublic: 1, added: 1 },
      dataRoles: { added: 1 },
      positions: { alreadyAssigned: 1, added: 1 }
    });
    expect(writes).toEqual([]);
  });

  it("permission copy apply 只写入缺失关系、三类回查且重复执行 unchanged", async () => {
    const assigned: Record<string, Set<string>> = {
      "userFeatureRole:employee-1": new Set(["feature-1"]),
      "userFeatureRole:employee-2": new Set(["feature-existing"]),
      "userDataRole:employee-1": new Set(["data-1"]),
      "userDataRole:employee-2": new Set([]),
      "employeePosition:employee-1": new Set(["position-1"]),
      "employeePosition:employee-2": new Set(["position-2"])
    };
    const writes: Array<{ resource: string; body: { parentId: string; childIds: string[] } }> = [];
    const { store } = await createPermissionCopyFixtureServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname.endsWith("/employee/findByCode")) {
          respond(response, url.searchParams.get("code") === "E1001"
            ? { id: "employee-1", code: "E1001", userName: "源员工", tenantCode: "tenant-a" }
            : { id: "employee-2", code: "E1002", userName: "目标员工", tenantCode: "tenant-a" });
          return;
        }
        const relation = ["userFeatureRole", "userDataRole", "employeePosition"].find((name) =>
          url.pathname.endsWith(`/${name}/getChildrenFromParentId`)
        );
        if (relation) {
          const parentId = url.searchParams.get("parentId")!;
          respond(response, [...(assigned[`${relation}:${parentId}`] ?? new Set())].map((id) => ({
            id,
            ...(id === "feature-1" ? { code: "FUNC_1" } : {}),
            ...(id === "data-1" ? { code: "DATA_1" } : {}),
            ...(id.startsWith("position-") ? { code: id.toUpperCase() } : {})
          })));
          return;
        }
        if (url.pathname.endsWith("/insertRelations")) {
          const resource = ["userFeatureRole", "userDataRole", "employeePosition"].find((name) =>
            url.pathname.endsWith(`/${name}/insertRelations`)
          )!;
          const body = (await readBody(request)) as { parentId: string; childIds: string[] };
          writes.push({ resource, body });
          for (const id of body.childIds) assigned[`${resource}:${body.parentId}`]!.add(id);
          respond(response, "ok");
          return;
        }
        respond(response, undefined, 404);
      }
    );
    const args = [
      "assign",
      "permission",
      "--source-employee-code",
      "E1001",
      "--target-employee-code",
      "E1002",
      "--apply"
    ];
    const output = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    const result = JSON.parse(output.text());
    expect(result.action).toBe("assigned");
    expect(result.verified).toBe(true);
    expect(result.added).toMatchObject({
      functionalRoles: [{ id: "feature-1" }],
      dataRoles: [{ id: "data-1" }],
      positions: [{ id: "position-1" }]
    });
    expect(writes).toEqual([
      { resource: "userFeatureRole", body: { parentId: "employee-2", childIds: ["feature-1"] } },
      { resource: "userDataRole", body: { parentId: "employee-2", childIds: ["data-1"] } },
      { resource: "employeePosition", body: { parentId: "employee-2", childIds: ["position-1"] } }
    ]);
    expect(result.operationId).toEqual(expect.any(String));
    await expect(new OperationLogStore(store.directory).load(result.operationId)).resolves.toMatchObject({
      status: "completed",
      actions: [
        expect.objectContaining({ resource: "userFeatureRole" }),
        expect.objectContaining({ resource: "userDataRole" }),
        expect.objectContaining({ resource: "employeePosition" })
      ]
    });
    vi.restoreAllMocks();

    const unchangedOutput = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    const unchanged = JSON.parse(unchangedOutput.text());
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.applied).toBe(false);
    expect(unchanged.verified).toBe(true);
    expect(writes).toHaveLength(3);
  });

  it("permission copy 拒绝相同员工", async () => {
    const { store } = await createPermissionCopyFixtureServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employee/findByCode")) {
        respond(response, { id: "employee-1", code: "E1001", userName: "同一员工", tenantCode: "tenant-a" });
        return;
      }
      respond(response, undefined, 404);
    });
    await expect(
      createProgram(store).parseAsync(
        [
          "assign",
          "permission",
          "--source-employee-code",
          "E1001",
          "--target-employee-code",
          "E1001"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("源员工和目标员工不能相同");
  });

  it("permission copy 拒绝重复的精确员工姓名", async () => {
    const { store } = await createPermissionCopyFixtureServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employee/quickSearch")) {
        respond(response, {
          rows: [
            { id: "employee-1", code: "E1001", userName: "重名员工", userAccount: "one" },
            { id: "employee-2", code: "E1002", userName: "重名员工", userAccount: "two" }
          ]
        });
        return;
      }
      respond(response, undefined, 404);
    });
    await expect(
      createProgram(store).parseAsync(
        [
          "assign",
          "permission",
          "--source-employee-name",
          "重名员工",
          "--target-employee-code",
          "E1003"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("源员工姓名存在重名");
  });

  it("permission copy API 失败后不重试且不继续后续写入", async () => {
    const calls: string[] = [];
    const { store } = await createPermissionCopyFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/employee/findByCode")) {
        respond(response, url.searchParams.get("code") === "E1001"
          ? { id: "employee-1", code: "E1001", userName: "源员工", tenantCode: "tenant-a" }
          : { id: "employee-2", code: "E1002", userName: "目标员工", tenantCode: "tenant-a" });
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/getChildrenFromParentId")) {
        respond(response, url.searchParams.get("parentId") === "employee-1"
          ? [{ id: "feature-1", code: "FUNC_1" }]
          : []);
        return;
      }
      if (url.pathname.endsWith("/userDataRole/getChildrenFromParentId")) {
        respond(response, url.searchParams.get("parentId") === "employee-1"
          ? [{ id: "data-1", code: "DATA_1" }]
          : []);
        return;
      }
      if (url.pathname.endsWith("/employeePosition/getChildrenFromParentId")) {
        respond(response, url.searchParams.get("parentId") === "employee-1"
          ? [{ id: "position-1", code: "POSITION_1" }]
          : []);
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/insertRelations")) {
        respond(response, "ok");
        return;
      }
      if (url.pathname.endsWith("/userDataRole/insertRelations")) {
        respond(response, undefined, 500);
        return;
      }
      if (url.pathname.endsWith("/employeePosition/insertRelations")) {
        respond(response, "unexpected", 500);
        return;
      }
      respond(response, undefined, 404);
    });
    await expect(
      createProgram(store).parseAsync(
        [
          "assign",
          "permission",
          "--source-employee-code",
          "E1001",
          "--target-employee-code",
          "E1002",
          "--apply"
        ],
        { from: "user" }
      )
    ).rejects.toThrow(/HTTP 500.*；部分关系可能已新增，可使用 operation-id [0-9a-f-]+ 回滚/);
    expect(calls.filter((call) => call.endsWith("/userFeatureRole/insertRelations"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/userDataRole/insertRelations"))).toHaveLength(1);
    expect(calls.some((call) => call.endsWith("/employeePosition/insertRelations"))).toBe(false);
  });

  it("data apply 默认预览并幂等创建数据角色", async () => {
    const roles: Array<Record<string, unknown>> = [];
    let saveCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/dataRoleGroup/findAll")) {
        respond(response, [{ id: "group-1", code: "ORG_ROLE", name: "组织角色" }]);
        return;
      }
      if (url.pathname.endsWith("/dataRole/findByPage")) {
        respond(response, { rows: roles });
        return;
      }
      if (url.pathname.endsWith("/dataRole/save")) {
        saveCount += 1;
        const saved = {
          ...((await readBody(request)) as Record<string, unknown>),
          id: "role-1"
        };
        roles.push(saved);
        respond(response, saved);
        return;
      }
      respond(response, undefined, 404);
    });
    const args = [
      "apply",
      "data-role",
      "--role-code",
      "ORG_READER",
      "--role-name",
      "组织只读角色",
      "--group",
      "ORG_ROLE"
    ];
    const previewOutput = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(JSON.parse(previewOutput.text()).action).toBe("create");
    expect(saveCount).toBe(0);
    vi.restoreAllMocks();

    const applyOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    expect(JSON.parse(applyOutput.text()).verified).toBe(true);
    expect(saveCount).toBe(1);
    vi.restoreAllMocks();

    captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    expect(saveCount).toBe(1);
  });

  it("data assign 预览不读取已分配值，正式执行时只补差集并回查", async () => {
    const assignedIds = new Set(["org-1"]);
    const requestedPaths: string[] = [];
    let insertCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith("/dataRole/findByPage")) {
        respond(response, {
          rows: [{ id: "role-1", code: "ORG_READER", name: "组织只读角色" }]
        });
        return;
      }
      if (url.pathname.endsWith("/dataAuthorizeType/findAll")) {
        respond(response, [
          { id: "auth-type-1", code: "ORG", name: "组织权限" }
        ]);
        return;
      }
      if (url.pathname.endsWith("/dataRoleAuthTypeValue/getAssignedAuthDatas")) {
        respond(
          response,
          [...assignedIds].map((id) => ({ id, code: id.toUpperCase() }))
        );
        return;
      }
      if (url.pathname.endsWith("/dataRoleAuthTypeValue/insertRelations")) {
        insertCount += 1;
        const body = (await readBody(request)) as {
          dataRoleId: string;
          dataAuthorizeTypeId: string;
          entityIds: string[];
        };
        expect(body.dataRoleId).toBe("role-1");
        expect(body.dataAuthorizeTypeId).toBe("auth-type-1");
        body.entityIds.forEach((id) => assignedIds.add(id));
        respond(response, null);
        return;
      }
      respond(response, undefined, 404);
    });
    const args = [
      "assign",
      "data",
      "--role",
      "ORG_READER",
      "--auth-type",
      "ORG",
      "--entity",
      "org-1",
      "--entity",
      "org-2"
    ];
    const previewOutput = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    const preview = JSON.parse(previewOutput.text());
    expect(preview.action).toBe("preview");
    expect(preview.cleanupMayOccur).toBe(false);
    expect(requestedPaths.some((path) => path.includes("getAssignedAuth"))).toBe(
      false
    );
    vi.restoreAllMocks();

    const applyOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    const applied = JSON.parse(applyOutput.text());
    expect(applied.addedEntityIds).toEqual(["org-2"]);
    expect(applied.cleanupMayOccur).toBe(true);
    expect(applied.verified).toBe(true);
    expect(insertCount).toBe(1);
    vi.restoreAllMocks();

    captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    expect(insertCount).toBe(1);
  });

  it("principal assign 按账号给用户补充功能角色并保持幂等", async () => {
    const assignedRoleIds = new Set<string>();
    let insertCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/user/findByPage")) {
        respond(response, {
          rows: [{ id: "user-1", account: "lin", userName: "测试用户" }]
        });
        return;
      }
      if (url.pathname.endsWith("/featureRole/findByPage")) {
        respond(response, {
          rows: [{ id: "role-1", code: "BASIC_READER", name: "基础只读角色" }]
        });
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/getChildrenFromParentId")) {
        respond(
          response,
          [...assignedRoleIds].map((id) => ({ id, code: "BASIC_READER" }))
        );
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/insertRelations")) {
        insertCount += 1;
        const body = (await readBody(request)) as {
          parentId: string;
          childIds: string[];
        };
        expect(body.parentId).toBe("user-1");
        body.childIds.forEach((id) => assignedRoleIds.add(id));
        respond(response, "ok");
        return;
      }
      respond(response, undefined, 404);
    });
    const args = [
      "assign",
      "role",
      "--subject-type",
      "user",
      "--subject",
      "lin",
      "--role-type",
      "functional",
      "--role",
      "BASIC_READER",
      "--apply"
    ];
    const output = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(JSON.parse(output.text()).verified).toBe(true);
    expect(insertCount).toBe(1);
    vi.restoreAllMocks();

    captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(insertCount).toBe(1);
  });

  it("verify 可按员工号解析账号和用户 ID", async () => {
    const { store } = await createFixtureServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employee/findByCode")) {
        expect(url.searchParams.get("code")).toBe("E1001");
        respond(response, {
          id: "user-1",
          code: "E1001",
          userName: "张三",
          userAccount: "zhangsan"
        });
        return;
      }
      if (url.pathname.endsWith("/user/getFeatureRolesByAccount")) {
        expect(url.searchParams.get("account")).toBe("zhangsan");
        respond(response, [{ id: "role-1", code: "BASIC_READER" }]);
        return;
      }
      if (url.pathname.endsWith("/user/getDataRolesByAccount")) {
        respond(response, []);
        return;
      }
      respond(response, undefined, 404);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      ["verify", "--employee-code", "E1001"],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.user).toMatchObject({
      account: "zhangsan",
      userId: "user-1",
      employeeCode: "E1001",
      employeeName: "张三"
    });
    expect(result.featureRoles[0].code).toBe("BASIC_READER");
  });

  it("verify 可按员工号和菜单名称校验目录菜单权限", async () => {
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employee/findByCode")) {
        respond(response, {
          id: "user-1",
          code: "20017267",
          userName: "测试员工",
          userAccount: "employee-account"
        });
        return;
      }
      if (url.pathname.endsWith("/user/getFeatureRolesByAccount")) {
        respond(response, []);
        return;
      }
      if (url.pathname.endsWith("/user/getDataRolesByAccount")) {
        respond(response, []);
        return;
      }
      if (url.pathname.endsWith("/menu/getMenuTree")) {
        respond(response, [
          {
            id: "menu-root",
            code: "SYSTEM_MANAGEMENT",
            name: "系统管理",
            children: [
              {
                id: "menu-tenant",
                code: "TENANT_MANAGEMENT",
                name: "租户管理",
                children: [
                  {
                    id: "menu-tenant-list",
                    code: "TENANT_LIST",
                    name: "租户列表",
                    featureCode: "TENANT_VIEW",
                    children: []
                  }
                ]
              }
            ]
          }
        ]);
        return;
      }
      if (url.pathname.endsWith("/user/checkUserFeaturesAuthority")) {
        expect(await readBody(request)).toEqual({
          userId: "user-1",
          featureCodes: ["TENANT_VIEW"]
        });
        respond(response, { TENANT_VIEW: true });
        return;
      }
      respond(response, undefined, 404);
    });
    const output = captureOutput();

    await createProgram(store).parseAsync(
      [
        "verify",
        "--employee-code",
        "20017267",
        "--menu",
        "租户管理"
      ],
      { from: "user" }
    );

    const result = JSON.parse(output.text());
    expect(result.menuChecks).toHaveLength(1);
    expect(result.menuChecks[0]).toMatchObject({
      selector: "租户管理",
      authorized: true,
      featureCodes: ["TENANT_VIEW"]
    });
    expect(result.menuChecks[0].menu.code).toBe("TENANT_MANAGEMENT");
  });

  it("principal revoke 默认预览，--apply 后移除用户角色并回查", async () => {
    const assignedRoleIds = new Set(["role-1"]);
    let removeCount = 0;
    const { store } = await createFixtureServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/employee/findByCode")) {
        respond(response, {
          id: "user-1",
          code: "E1001",
          userName: "张三",
          userAccount: "zhangsan"
        });
        return;
      }
      if (url.pathname.endsWith("/featureRole/findByPage")) {
        respond(response, {
          rows: [{ id: "role-1", code: "BASIC_READER", name: "基础只读角色" }]
        });
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/getChildrenFromParentId")) {
        respond(
          response,
          [...assignedRoleIds].map((id) => ({
            id,
            code: "BASIC_READER"
          }))
        );
        return;
      }
      if (url.pathname.endsWith("/userFeatureRole/removeRelations")) {
        removeCount += 1;
        const body = (await readBody(request)) as {
          parentId: string;
          childIds: string[];
        };
        expect(body.parentId).toBe("user-1");
        body.childIds.forEach((id) => assignedRoleIds.delete(id));
        respond(response, "ok");
        return;
      }
      respond(response, undefined, 404);
    });
    const args = [
      "revoke",
      "role",
      "--subject-type",
      "user",
      "--employee-code",
      "E1001",
      "--role-type",
      "functional",
      "--role",
      "BASIC_READER"
    ];

    const previewOutput = captureOutput();
    await createProgram(store).parseAsync(args, { from: "user" });
    expect(JSON.parse(previewOutput.text()).action).toBe("preview");
    expect(removeCount).toBe(0);
    vi.restoreAllMocks();

    const applyOutput = captureOutput();
    await createProgram(store).parseAsync([...args, "--apply"], { from: "user" });
    expect(JSON.parse(applyOutput.text()).verified).toBe(true);
    expect(removeCount).toBe(1);
  });
});

async function createFixtureServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse
  ) => void | Promise<void>
): Promise<{ store: ConfigStore }> {
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器启动失败");
  }
  const directory = await mkdtemp(join(tmpdir(), "eadp-permission-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: "dev",
    environments: {
      dev: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "secret",
        tenantCode: "tenant-a"
      }
    }
  });
  return { store };
}

async function createPermissionCopyFixtureServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse
  ) => void | Promise<void>
): Promise<{ store: ConfigStore }> {
  return createFixtureServer(handler);
}

function captureOutput(): { text: () => string } {
  let text = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  return { text: () => text };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) : undefined;
}

function respond(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      success: status >= 200 && status < 300,
      message: status >= 400 ? "not found" : "ok",
      data
    })
  );
}
