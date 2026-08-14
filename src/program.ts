import { Command } from "commander";
import { registerApiCommands } from "./commands/api.js";
import { registerBpmCommands } from "./commands/bpm.js";
import { registerEnvironmentCommands } from "./commands/env.js";
import { registerPermissionCommands } from "./commands/permission.js";
import { registerResourceCommands } from "./commands/resource.js";
import { registerRollbackCommand } from "./commands/rollback.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerMenuCommands } from "./menu/command.js";
import {
  registerPermissionVerbCommands,
  registerVerbCommands
} from "./commands/verbs.js";
import { ConfigStore } from "./config/store.js";
import { CliError, errorMessage } from "./errors.js";
import { addRuntimeOptions } from "./runtime-options.js";
import { cliVersion } from "./version.js";

export function createProgram(store = new ConfigStore()): Command {
  const program = new Command();
  program
    .name("eadp")
    .description("EADP 多环境 API 命令行工具")
    .version(cliVersion)
    .showHelpAfterError();

  addRuntimeOptions(program);
  const commands = registerVerbCommands(program);
  const permissionCommands = registerPermissionVerbCommands(program);
  registerEnvironmentCommands(program, store);
  registerResourceCommands(store, program);
  registerMenuCommands(program, store);
  registerApiCommands(commands, store, program);
  registerBpmCommands(store, program);
  registerPermissionCommands(permissionCommands, store, program);
  registerRollbackCommand(program, store);
  registerSkillCommands(program);
  registerUpdateCommand(program);
  return program;
}

export async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    process.stderr.write(`错误：${errorMessage(error)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}
