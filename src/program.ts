import { Command } from "commander";
import { registerBpmCommands } from "./commands/bpm.js";
import { registerEnvironmentCommands } from "./commands/env.js";
import { registerPermissionCommands } from "./commands/permission.js";
import { registerResourceCommands } from "./commands/resource.js";
import { registerRollbackCommand } from "./commands/rollback.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerMenuCommands } from "./commands/menu.js";
import {
  registerPermissionVerbCommands
} from "./commands/verbs.js";
import { ConfigStore } from "./config/store.js";
import { CliError, renderCliError } from "./errors.js";
import { addRuntimeOptions } from "./runtime-options.js";
import { cliVersion } from "./version.js";

export function createProgram(store = new ConfigStore()): Command {
  const program = new Command();
  program
    .name("eadp")
    .description("EADP 多环境资源与权限命令行工具")
    .version(cliVersion)
    .showHelpAfterError()
    // Commander normally writes its own prose error/help before throwing.
    // Failures are rendered exactly once by main() as a JSON envelope.
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();

  addRuntimeOptions(program);
  const permissionCommands = registerPermissionVerbCommands(program);
  registerEnvironmentCommands(program, store);
  registerResourceCommands(store, program);
  registerMenuCommands(program, store);
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
    // With exitOverride(), `--help`/`--version` throw a CommanderError after
    // already printing to stdout; that is a successful exit, not a failure.
    if (isSuccessfulCommanderExit(error)) {
      return;
    }
    process.stderr.write(`${JSON.stringify(renderCliError(error))}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

function isSuccessfulCommanderExit(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as unknown as Record<string, unknown>).code === "string" &&
    String((error as unknown as Record<string, unknown>).code).startsWith("commander.") &&
    (error as unknown as { exitCode?: unknown }).exitCode === 0
  );
}
