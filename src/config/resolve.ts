import { CliError } from "../errors.js";
import type { EadpConfig, EnvironmentConfig } from "./schema.js";

export interface ResolvedEnvironment {
  name: string;
  config: EnvironmentConfig;
  token?: string;
  authorization?: string;
}

export function resolveEnvironment(
  config: EadpConfig,
  requestedName?: string,
  environmentVariables: NodeJS.ProcessEnv = process.env
): ResolvedEnvironment {
  const name = requestedName ?? config.currentEnvironment;
  if (!name) {
    throw new CliError("未指定环境，且尚未配置 currentEnvironment", 1, {
      code: "ENVIRONMENT_UNKNOWN",
      candidates: Object.keys(config.environments ?? {}),
      requiredInput: "environment"
    });
  }
  const environment = config.environments[name];
  if (!environment) {
    throw new CliError(`环境不存在：${name}`, 1, {
      code: "ENVIRONMENT_UNKNOWN",
      candidates: Object.keys(config.environments ?? {}),
      requiredInput: "environment"
    });
  }

  // Authorization is the implicit credential and takes precedence over a
  // configured token (or tokenEnv) when both are present.
  if (environment.authorization) {
    return { name, config: environment, authorization: environment.authorization };
  }

  const token = environment.token ?? environmentVariables[environment.tokenEnv!];
  if (!token) {
    throw new CliError(
      environment.tokenEnv
        ? `环境 ${name} 引用的环境变量未设置：${environment.tokenEnv}`
        : `环境 ${name} 未配置可用认证，请在配置文件中设置 authorization，或配置 token/tokenEnv`
    );
  }
  return { name, config: environment, token };
}
