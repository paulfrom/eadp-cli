import { Command, Option } from "commander";
import { CliError } from "./errors.js";
import { setOutputMode, type OutputMode } from "./io.js";

export interface RuntimeOptions {
  timeoutMs: number;
  compact: boolean;
  output: OutputMode;
}

export function addRuntimeOptions(program: Command): void {
  program
    .addOption(
      new Option("--timeout <ms>", "全局 EADP 请求超时时间")
        .default(30_000)
        .argParser(parseTimeout)
    )
    .addOption(
      new Option("--output <format>", "输出格式：json（默认）、compact、compact-ndjson（meta/row 列式 NDJSON）")
        .choices(["json", "compact", "compact-ndjson"])
        .default("json")
    )
    .option("--compact", "输出单行 JSON")
    .addHelpText(
      "after",
      `
输出格式：默认 json；compact 为单行 JSON；compact-ndjson 首行输出含 type/schema 的 meta，
后续每行输出含 type/key/v 的 row，适合低 token 机器消费。`
    );
}

export function getRuntimeOptions(program: Command): RuntimeOptions {
  const options = program.opts<{
    timeout: number;
    compact?: boolean;
    output?: OutputMode;
  }>();
  const output = resolveOutputMode(options.output, options.compact === true);
  setOutputMode(output);
  return {
    timeoutMs: options.timeout,
    compact: output === "compact",
    output
  };
}

function resolveOutputMode(output: OutputMode | undefined, compact: boolean): OutputMode {
  if (output === "compact-ndjson") {
    return output;
  }
  if (output === "compact" || compact) {
    return "compact";
  }
  return "json";
}

function parseTimeout(source: string): number {
  const timeoutMs = Number(source);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`超时时间无效：${source}`);
  }
  return timeoutMs;
}
