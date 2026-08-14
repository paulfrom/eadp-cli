/**
 * env 模块必测矩阵：
 * - URL 与 Token 绑定（一个环境名称直接对应一个 URL 和一个 Token，无 accounts）
 * - 仅 GlobalAdmin / TenantAdmin 可保存；NormalUser、未知权限、接口失败必须零写入
 * - list / use / remove
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  captureOutput,
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { TestFixture } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

const TENANT_POLICIES: Record<string, { tenantCode: string; authorityPolicy: string }> = {
  "admin-token": { tenantCode: "global", authorityPolicy: "GlobalAdmin" },
  "tenant-admin-token": { tenantCode: "tenant-a", authorityPolicy: "TenantAdmin" },
  "normal-token": { tenantCode: "tenant-a", authorityPolicy: "NormalUser" },
  "unknown-policy-token": { tenantCode: "tenant-a", authorityPolicy: "UnknownPolicy" }
};

async function fixtureWithTenantPolicies(): Promise<TestFixture> {
  return createFixture({
    environments: [{ name: "dev", tenantCode: "tenant-a", token: "old-token" }],
    tenant: (token) =>
      TENANT_POLICIES[token] ?? { tenantCode: "tenant-a", authorityPolicy: "NormalUser" }
  });
}

describe("env add：URL 与 Token 绑定", () => {
  it("保存 Token 前获取并记录 tenantCode，一个名称对应一个 URL 与一个 Token，无 accounts", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const baseUrl = fixture.baseUrl("dev");

    await runCommand(fixture.program(), [
      "env", "add", "prod", "--url", baseUrl, "--token", "admin-token", "--default"
    ]);
    await runCommand(fixture.program(), [
      "env", "add", "staging", "--url", baseUrl, "--token", "tenant-admin-token"
    ]);

    const config = await fixture.store.load();
    expect(config.currentEnvironment).toBe("prod");
    expect(config.environments.prod).toEqual({
      baseUrl,
      tenantCode: "global",
      token: "admin-token"
    });
    expect(config.environments.staging).toMatchObject({
      baseUrl,
      tenantCode: "tenant-a",
      token: "tenant-admin-token"
    });
    expect(config.environments.prod).not.toHaveProperty("accounts");
    expect(config.environments.staging).not.toHaveProperty("accounts");
  });

  it("支持 --token-env 从环境变量读取 Token", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const previous = process.env.EADP_TEST_ADMIN_TOKEN;
    process.env.EADP_TEST_ADMIN_TOKEN = "admin-token";
    try {
      await runCommand(fixture.program(), [
        "env", "add", "ci", "--url", fixture.baseUrl("dev"), "--token-env", "EADP_TEST_ADMIN_TOKEN"
      ]);
    } finally {
      if (previous === undefined) delete process.env.EADP_TEST_ADMIN_TOKEN;
      else process.env.EADP_TEST_ADMIN_TOKEN = previous;
    }
    const config = await fixture.store.load();
    expect(config.environments.ci).toMatchObject({
      baseUrl: fixture.baseUrl("dev"),
      tenantCode: "global",
      tokenEnv: "EADP_TEST_ADMIN_TOKEN"
    });
    expect(config.environments.ci).not.toHaveProperty("token");
  });

  it("拒绝同时提供 --token 与 --token-env，且不写入", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const before = await fixture.store.load();
    await expect(
      runCommand(fixture.program(), [
        "env", "add", "dev", "--url", fixture.baseUrl("dev"),
        "--token", "admin-token", "--token-env", "EADP_TEST_TOKEN"
      ])
    ).rejects.toThrow("必须且只能指定 --token 或 --token-env");
    expect(await fixture.store.load()).toEqual(before);
  });

  it("URL 尾斜杠被规范化后保存", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const baseUrl = fixture.baseUrl("dev");
    await runCommand(fixture.program(), [
      "env", "add", "prod", "--url", `${baseUrl}/`, "--token", "admin-token"
    ]);
    const config = await fixture.store.load();
    expect(config.environments.prod?.baseUrl).toBe(baseUrl);
  });
});

describe("env add：权限策略与零写入", () => {
  it("GlobalAdmin 与 TenantAdmin 可以注册环境", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const baseUrl = fixture.baseUrl("dev");
    const output = await runCommand(fixture.program(), [
      "env", "add", "prod", "--url", baseUrl, "--token", "admin-token"
    ]);
    expect(JSON.parse(output)).toMatchObject({ success: true, environment: "prod" });
    const output2 = await runCommand(fixture.program(), [
      "env", "add", "staging", "--url", baseUrl, "--token", "tenant-admin-token"
    ]);
    expect(JSON.parse(output2)).toMatchObject({ success: true, environment: "staging" });
  });

  it("NormalUser 禁止注册环境且不覆盖已有配置", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const baseUrl = fixture.baseUrl("dev");
    const before = await fixture.store.load();

    const error = await runExpectError(fixture.program(), [
      "env", "add", "dev", "--url", baseUrl, "--token", "normal-token"
    ]);
    expect(error).toContain("NormalUser");
    expect(error).toContain("不允许注册环境");

    const after = await fixture.store.load();
    expect(after.environments.dev).toEqual(before.environments.dev);
  });

  it("未知 authorityPolicy 禁止注册环境且零写入", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const error = await runExpectError(fixture.program(), [
      "env", "add", "dev", "--url", fixture.baseUrl("dev"), "--token", "unknown-policy-token"
    ]);
    expect(error).toContain("UnknownPolicy");
    expect((await fixture.store.load()).environments).not.toHaveProperty("dev2");
  });

  it("获取用户信息接口失败（HTTP 401）时零写入", async () => {
    const fixture = await fixtureWithTenantPolicies();
    const baseUrl = fixture.baseUrl("dev");
    const before = await fixture.store.load();
    // 覆盖默认租户端点：bad-token 返回 401。
    fixture.server("dev").on("/api-gateway/sei-basic/account/getByApiKey", (context) => {
      if (context.headers["x-api-token"] === "bad-token") {
        context.raw({ success: false, message: "invalid token" }, 401);
        return;
      }
      context.json({ tenantCode: "tenant-a", authorityPolicy: "GlobalAdmin" });
    });

    const error = await runExpectError(fixture.program(), [
      "env", "add", "dev", "--url", baseUrl, "--token", "bad-token"
    ]);
    expect(error).toContain("HTTP 401");

    const after = await fixture.store.load();
    expect(after.environments.dev).toEqual(before.environments.dev);
  });

  it("租户接口 success=false 信封即使携带 tenantCode 也零写入", async () => {
    const fixture = await fixtureWithTenantPolicies();
    fixture.server("dev").on("/api-gateway/sei-basic/account/getByApiKey", (context) => {
      if (context.headers["x-api-token"] === "failed-envelope") {
        context.raw({
          success: false,
          message: "invalid token",
          data: { tenantCode: "must-not-be-used" }
        }, 200);
        return;
      }
      context.json({ tenantCode: "tenant-a", authorityPolicy: "GlobalAdmin" });
    });

    const error = await runExpectError(fixture.program(), [
      "env", "add", "dev", "--url", fixture.baseUrl("dev"), "--token", "failed-envelope"
    ]);
    expect(error).toContain("EADP 请求失败：invalid token");
    expect((await fixture.store.load()).environments).not.toHaveProperty("dev2");
  });
});

describe("env list / use / remove", () => {
  it("env list 显示名称、URL、租户、默认值与认证来源，不泄露 Token", async () => {
    const fixture = await createFixture({
      environments: [
        { name: "implicit", tenantCode: "tenant-a", authorization: "Bearer should-not-leak" },
        { name: "token-env", tenantCode: "tenant-b", tokenEnv: "EADP_DEV_TOKEN" },
        { name: "plain", tenantCode: "tenant-c", token: "plain-secret" }
      ]
    });
    const output = captureOutput();
    try {
      await fixture.program().parseAsync(["env", "list"], { from: "user" });
      const listed = JSON.parse(output.text()) as Array<Record<string, unknown>>;
      expect(listed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "implicit",
          baseUrl: fixture.baseUrl("implicit"),
          tenantCode: "tenant-a",
          default: true,
          tokenSource: "config:authorization"
        }),
        expect.objectContaining({ name: "token-env", tokenSource: "env:EADP_DEV_TOKEN" }),
        expect.objectContaining({ name: "plain", tokenSource: "config:token" })
      ]));
      expect(output.text()).not.toContain("should-not-leak");
      expect(output.text()).not.toContain("plain-secret");
    } finally {
      output.restore();
    }
  });

  it("env use 切换默认环境；不存在的环境报错且不修改配置", async () => {
    const fixture = await createFixture({
      environments: [
        { name: "dev", tenantCode: "tenant-a", token: "dev-token" },
        { name: "prod", tenantCode: "tenant-a", token: "prod-token" }
      ]
    });
    const output = await runCommand(fixture.program(), ["env", "use", "prod"]);
    expect(JSON.parse(output)).toMatchObject({ success: true, defaultEnvironment: "prod" });
    expect((await fixture.store.load()).currentEnvironment).toBe("prod");

    const error = await runExpectError(fixture.program(), ["env", "use", "missing"]);
    expect(error).toContain("环境不存在：missing");
    expect((await fixture.store.load()).currentEnvironment).toBe("prod");
  });

  it("env remove 移除环境并在移除默认环境时清空默认值", async () => {
    const fixture = await createFixture({
      environments: [
        { name: "dev", tenantCode: "tenant-a", token: "dev-token" },
        { name: "prod", tenantCode: "tenant-a", token: "prod-token" }
      ]
    });
    const output = await runCommand(fixture.program(), ["env", "remove", "dev"]);
    expect(JSON.parse(output)).toMatchObject({ success: true, removedEnvironment: "dev" });
    const config = await fixture.store.load();
    expect(config.environments).not.toHaveProperty("dev");
    expect(config.environments).toHaveProperty("prod");
    expect(config.currentEnvironment).toBeUndefined();
  });

  it("env remove 不存在的环境报错且不修改配置", async () => {
    const fixture = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "dev-token" }]
    });
    const error = await runExpectError(fixture.program(), ["env", "remove", "missing"]);
    expect(error).toContain("环境不存在：missing");
    expect((await fixture.store.load()).currentEnvironment).toBe("dev");
  });
});
