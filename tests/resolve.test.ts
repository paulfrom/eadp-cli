import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/resolve.js";
import type { EadpConfig, EnvironmentConfig } from "../src/config/schema.js";

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
});
