import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/resolve.js";
import {
  environmentSchema,
  type EadpConfig,
  type EnvironmentConfig
} from "../src/config/schema.js";
import {
  assertPathTenantScope,
  assertTenantScope,
  scopeForPath
} from "../src/tenant.js";

const environment = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  baseUrl: "http://localhost:3000",
  token: "default-token",
  ...overrides
});

describe("resolveEnvironment", () => {
  it("显式环境优先于默认环境，并直接返回该环境 Token", () => {
    const config: EadpConfig = {
      currentEnvironment: "dev",
      environments: {
        dev: environment(),
        dev2: environment({ token: "readonly-token" })
      }
    };
    expect(resolveEnvironment(config, "dev2")).toMatchObject({
      name: "dev2",
      token: "readonly-token"
    });
  });

  it("省略名称时使用默认环境", () => {
    const config: EadpConfig = {
      currentEnvironment: "dev",
      environments: { dev: environment({ token: "admin-token" }) }
    };
    expect(resolveEnvironment(config)).toMatchObject({ name: "dev", token: "admin-token" });
  });

  it("从环境变量解析该环境 Token", () => {
    const config: EadpConfig = {
      currentEnvironment: "ci",
      environments: { ci: environment({ token: undefined, tokenEnv: "EADP_TEST_TOKEN" }) }
    };
    expect(resolveEnvironment(config, undefined, { EADP_TEST_TOKEN: "env-secret" }).token)
      .toBe("env-secret");
  });

  it("Token 环境变量不存在时明确报错", () => {
    const config: EadpConfig = {
      currentEnvironment: "ci",
      environments: { ci: environment({ token: undefined, tokenEnv: "EADP_TEST_TOKEN" }) }
    };
    expect(() => resolveEnvironment(config, undefined, {})).toThrow(
      "环境 ci 引用的环境变量未设置：EADP_TEST_TOKEN"
    );
  });

  it("Authorization 优先于显式 Token 返回", () => {
    const config: EadpConfig = {
      currentEnvironment: "implicit",
      environments: {
        implicit: environment({ token: "display-token", authorization: "Bearer implicit-secret" })
      }
    };
    expect(resolveEnvironment(config)).toMatchObject({ authorization: "Bearer implicit-secret" });
    expect(resolveEnvironment(config).token).toBeUndefined();
  });

  it("两种认证都不存在时要求用户配置环境凭证", () => {
    const config: EadpConfig = {
      currentEnvironment: "empty",
      environments: { empty: environment({ token: undefined }) }
    };
    expect(() => resolveEnvironment(config)).toThrow("未配置可用认证");
  });

  it("仍禁止同时配置 token 与 tokenEnv", () => {
    expect(() =>
      environmentSchema.parse({
        baseUrl: "http://localhost:3000",
        token: "display-token",
        tokenEnv: "EADP_TEST_TOKEN"
      })
    ).toThrow("环境不能同时配置 token 和 tokenEnv");
  });
});

describe("租户操作策略", () => {
  it("功能项、菜单、应用模块和给号配置路径属于 global 操作", () => {
    expect(scopeForPath("/api-gateway/sei-basic/feature/findByPage")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/appModule/findAll")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/featureGroup/getAuthorizedFeatureGroup")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/menu/getMenuTree")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/serialNumberConfig/save")).toBe("global");
  });

  it("权限角色、用户和 BPM 路径属于非 global 操作", () => {
    expect(scopeForPath("/api-gateway/sei-basic/featureRole/findByPage")).toBe("non-global");
    expect(scopeForPath("/api-gateway/sei-basic/user/getFeatureRolesByAccount")).toBe("non-global");
    expect(scopeForPath("/api-gateway/sei-bpm/conBusinessEntity/findByPage")).toBe("non-global");
  });

  it("阻止不匹配的租户执行操作", () => {
    expect(() => assertPathTenantScope("tenant-a", "/feature/findByPage", "dev"))
      .toThrow("必须使用 global 租户");
    expect(() => assertPathTenantScope("global", "/featureRole/findByPage", "dev"))
      .toThrow("必须使用非 global 租户");
    expect(() => assertTenantScope(undefined, "non-global", "dev"))
      .toThrow("请重新执行 env add 验证 Token");
  });
});
