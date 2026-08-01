import { CliError } from "../errors.js";
import type { EadpConfig, EnvironmentConfig } from "./schema.js";

export interface ResolvedEnvironment {
  name: string;
  config: EnvironmentConfig;
  token: string;
}

export function resolveEnvironment(
  config: EadpConfig,
  requestedName?: string,
  environmentVariables: NodeJS.ProcessEnv = process.env
): ResolvedEnvironment {
  const name = requestedName ?? config.currentEnvironment;
  if (!name) {
    throw new CliError("未指定环境，且尚未配置 currentEnvironment");
  }
  const environment = config.environments[name];
  if (!environment) {
    throw new CliError(`环境不存在：${name}`);
  }
  const token = environment.token ?? environmentVariables[environment.tokenEnv!];
  if (!token) {
    throw new CliError(
      environment.tokenEnv
        ? `环境 ${name} 引用的环境变量未设置：${environment.tokenEnv}`
        : `环境 ${name} 没有可用 Token`
    );
  }
  return { name, config: environment, token };
}
