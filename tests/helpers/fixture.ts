/**
 * 统一测试夹具：一个临时配置目录 + 若干 mock 环境（每个环境一个
 * MockEadpServer 实例），并自动注册 getByApiKey 租户端点。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConfigStore } from "../../src/config/store.js";
import { createProgram } from "../../src/program.js";
import type { EadpConfig } from "../../src/config/schema.js";
import { trackDirectory, trackServer } from "./lifecycle.js";
import { MockEadpServer, type TenantInfo } from "./server.js";

export interface FixtureEnvironment {
  name: string;
  tenantCode?: string;
  token?: string;
  authorization?: string;
  tokenEnv?: string;
}

export interface FixtureOptions {
  environments?: FixtureEnvironment[];
  /** 覆盖默认租户解析器（按 token 返回租户信息）。 */
  tenant?: (token: string, environmentName: string) => TenantInfo;
  /** 默认租户解析器策略；缺省返回 GlobalAdmin/global。 */
  defaultAuthorityPolicy?: string;
}

export interface TestFixture {
  /** 临时配置目录（含 config.yaml 与 operations/）。 */
  directory: string;
  store: ConfigStore;
  /** 按环境名取 mock 服务器。 */
  server(name: string): MockEadpServer;
  /** 环境的基础 URL。 */
  baseUrl(name: string): string;
  /** 返回一个绑定该 store 的 CLI 程序实例。 */
  program(): Command;
}

export async function createFixture(options: FixtureOptions = {}): Promise<TestFixture> {
  const environments = options.environments ?? [
    { name: "source", tenantCode: "global", token: "source-token" },
    { name: "target", tenantCode: "global", token: "target-token" }
  ];
  const directory = await mkdtemp(join(tmpdir(), "eadp-test-"));
  trackDirectory(directory);
  const servers = new Map<string, MockEadpServer>();
  const urls = new Map<string, string>();
  const environmentConfig: EadpConfig["environments"] = {};

  for (const environment of environments) {
    const server = new MockEadpServer();
    trackServer(server);
    if (options.tenant) {
      server.tenant = (token) => options.tenant!(token, environment.name);
    } else {
      const policy = options.defaultAuthorityPolicy ?? "GlobalAdmin";
      server.tenant = () => ({
        tenantCode: policy === "GlobalAdmin" ? "global" : "tenant-a",
        authorityPolicy: policy
      });
    }
    server.onTenantEndpoint();
    servers.set(environment.name, server);
    const baseUrl = await server.start();
    urls.set(environment.name, baseUrl);
    environmentConfig[environment.name] = {
      baseUrl,
      ...(environment.tenantCode === undefined ? {} : { tenantCode: environment.tenantCode }),
      ...(environment.authorization
        ? { authorization: environment.authorization }
        : environment.tokenEnv
          ? { tokenEnv: environment.tokenEnv }
          : { token: environment.token ?? "secret" })
    };
  }

  const store = new ConfigStore(join(directory, "config"));
  await store.save({
    currentEnvironment: environments[0]?.name,
    environments: environmentConfig
  });

  return {
    directory,
    store,
    server: (name) => {
      const server = servers.get(name);
      if (!server) throw new Error(`测试环境不存在：${name}`);
      return server;
    },
    baseUrl: (name) => {
      const url = urls.get(name);
      if (!url) throw new Error(`测试环境不存在：${name}`);
      return url;
    },
    program: () => createProgram(store)
  };
}
