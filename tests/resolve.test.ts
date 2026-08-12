import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/resolve.js";
import { environmentSchema, type EadpConfig, type EnvironmentConfig } from "../src/config/schema.js";

const environment = (
  overrides: Partial<EnvironmentConfig> = {}
): EnvironmentConfig => ({
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
        dev2: environment({
          baseUrl: "http://localhost:3000",
          token: "readonly-token"
        })
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
      environments: {
        dev: environment({ token: "admin-token" })
      }
    };

    expect(resolveEnvironment(config)).toMatchObject({
      name: "dev",
      token: "admin-token"
    });
  });

  it("从环境变量解析该环境 Token", () => {
    const config: EadpConfig = {
      currentEnvironment: "ci",
      environments: {
        ci: environment({ token: undefined, tokenEnv: "EADP_TEST_TOKEN" })
      }
    };

    expect(resolveEnvironment(config, undefined, { EADP_TEST_TOKEN: "env-secret" }).token).toBe(
      "env-secret"
    );
  });

  it("Token 环境变量不存在时明确报错", () => {
    const config: EadpConfig = {
      currentEnvironment: "ci",
      environments: {
        ci: environment({ token: undefined, tokenEnv: "EADP_TEST_TOKEN" })
      }
    };

    expect(() => resolveEnvironment(config, undefined, {})).toThrow(
      "环境 ci 引用的环境变量未设置：EADP_TEST_TOKEN"
    );
  });

  it("支持仅配置 Authorization 的隐式认证环境", () => {
    const config: EadpConfig = {
      currentEnvironment: "implicit",
      environments: {
        implicit: environment({
          token: undefined,
          authorization: "Bearer implicit-secret"
        })
      }
    };

    expect(resolveEnvironment(config)).toMatchObject({
      name: "implicit",
      authorization: "Bearer implicit-secret"
    });
    expect(resolveEnvironment(config).token).toBeUndefined();
  });

  it("Authorization 与显式 Token 同时存在时优先返回 Authorization", () => {
    const config: EadpConfig = {
      currentEnvironment: "implicit",
      environments: {
        implicit: environment({
          token: "display-token",
          authorization: "Bearer implicit-secret"
        })
      }
    };

    expect(resolveEnvironment(config)).toMatchObject({
      authorization: "Bearer implicit-secret"
    });
    expect(resolveEnvironment(config).token).toBeUndefined();
  });

  it("两种认证都不存在时要求用户配置环境凭证", () => {
    const config: EadpConfig = {
      currentEnvironment: "empty",
      environments: {
        empty: environment({ token: undefined })
      }
    };

    expect(() => resolveEnvironment(config)).toThrow(
      "环境 empty 未配置可用认证，请在配置文件中设置 authorization，或配置 token/tokenEnv"
    );
  });

  it("仍禁止同时配置 token 与 tokenEnv", () => {
    expect(() =>
      environmentSchema.parse({
        baseUrl: "http://localhost:3000",
        token: "display-token",
        tokenEnv: "EADP_TEST_TOKEN",
        authorization: "Bearer implicit-secret"
      })
    ).toThrow("环境不能同时配置 token 和 tokenEnv");
  });
});
