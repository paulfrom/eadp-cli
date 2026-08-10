import { Command, Option } from "commander";
import { CliError } from "./errors.js";

export interface RuntimeOptions {
  timeoutMs: number;
  compact: boolean;
}

export function addRuntimeOptions(program: Command): void {
  program
    .addOption(
      new Option("--timeout <ms>", "全局 EADP 请求超时时间")
        .default(30_000)
        .argParser(parseTimeout)
    )
    .option("--compact", "输出单行 JSON");
}

export function getRuntimeOptions(program: Command): RuntimeOptions {
  const options = program.opts<{ timeout: number; compact?: boolean }>();
  return {
    timeoutMs: options.timeout,
    compact: options.compact === true
  };
}

function parseTimeout(source: string): number {
  const timeoutMs = Number(source);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`超时时间无效：${source}`);
  }
  return timeoutMs;
}
