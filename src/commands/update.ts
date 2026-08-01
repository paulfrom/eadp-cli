import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns
} from "node:child_process";
import { join } from "node:path";
import { Command } from "commander";
import { CliError, errorMessage } from "../errors.js";
import { printValue } from "../io.js";

const cliPackageName = "eadp-cli";
const skillName = "eadp-operator";

export type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<string>;

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("同时升级 eadp CLI 和 AI Skill")
    .action(async () => {
      await updateCliAndSkill();
    });
}

export async function updateCliAndSkill(
  run: CommandRunner = runProcess
): Promise<void> {
  const npm = npmInvocation();
  const npmOptions = { encoding: "utf8", shell: npm.shell } as const;

  const installation = run(
    npm.command,
    [...npm.args, "install", "--global", `${cliPackageName}@latest`],
    npmOptions
  );
  try {
    assertSucceeded(installation, "升级 eadp-cli 失败");
  } catch (error) {
    throw new CliError(`${errorMessage(error)}；未执行 Skill 操作`);
  }

  let globalPrefix: string;
  try {
    const prefixResult = run(
      npm.command,
      [...npm.args, "prefix", "--global"],
      npmOptions
    );
    assertSucceeded(prefixResult, "定位 npm 全局安装目录失败");
    globalPrefix = prefixResult.stdout.trim();
    if (!globalPrefix) {
      throw new CliError("定位 npm 全局安装目录失败：npm 未返回路径");
    }
  } catch (error) {
    throw new CliError(
      `eadp-cli 可能已升级，但定位全局入口失败：${errorMessage(error)}`
    );
  }

  const executable =
    process.platform === "win32"
      ? join(globalPrefix, "eadp.cmd")
      : join(globalPrefix, "bin", "eadp");
  const skillUpgrade = run(executable, ["skill", "install"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  try {
    assertSucceeded(skillUpgrade, "升级 eadp-operator Skill 失败");
  } catch (error) {
    throw new CliError(`eadp-cli 已升级，但 ${errorMessage(error)}`);
  }

  printValue({
    success: true,
    cli: {
      package: cliPackageName,
      version: "latest",
      operation: "upgrade"
    },
    skill: {
      name: skillName,
      operation: "install-or-upgrade"
    },
    executable
  });
}

function npmInvocation(): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath],
      shell: false
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [],
    shell: process.platform === "win32"
  };
}

function runProcess(
  command: string,
  args: string[],
  options: SpawnSyncOptions
): SpawnSyncReturns<string> {
  return spawnSync(command, args, options) as SpawnSyncReturns<string>;
}

function assertSucceeded(
  result: SpawnSyncReturns<string>,
  operation: string
): void {
  if (result.status === 0) {
    return;
  }

  const detail =
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    result.error?.message ||
    "未知错误";
  throw new CliError(`${operation}：${detail}`);
}
