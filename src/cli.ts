#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerApiCommands } from "./commands/api.js";
import { registerBpmCommands } from "./commands/bpm.js";
import { registerEnvironmentCommands } from "./commands/env.js";
import { registerPermissionCommands } from "./commands/permission.js";
import { registerResourceCommands } from "./commands/resource.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerVerbCommands } from "./commands/verbs.js";
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
  registerEnvironmentCommands(program, store);
  registerResourceCommands(commands, store, program);
  registerApiCommands(commands, store, program);
  registerBpmCommands(commands, store, program);
  registerPermissionCommands(commands, store, program);
  registerSkillCommands(program);
  registerUpdateCommand(program);
  return program;
}

async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    process.stderr.write(`错误：${errorMessage(error)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

if (isMainModule()) {
  await main();
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const entryPath = realpathSync(resolve(process.argv[1]));
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}
