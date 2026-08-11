import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

export async function readJsonInput(options: {
  bodyFile?: string | undefined;
  data?: string | undefined;
}): Promise<unknown | undefined> {
  if (options.bodyFile && options.data) {
    throw new CliError("--body 和 --data 不能同时使用");
  }
  if (!options.bodyFile && !options.data) {
    return undefined;
  }
  const source = options.data ?? (await readFile(options.bodyFile!, "utf8"));
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CliError(`请求体不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePairs(values: string[], separator: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const value of values) {
    const index = value.indexOf(separator);
    if (index <= 0) {
      throw new CliError(`参数格式错误：${value}`);
    }
    const name = value.slice(0, index).trim();
    const item = value.slice(index + separator.length).trim();
    (result[name] ??= []).push(item);
  }
  return result;
}

export function flattenPairs(values: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, items]) => [name, items[items.length - 1] ?? ""])
  );
}

export function printValue(value: unknown, compact = false): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

export async function printJsonLine(value: unknown): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
    await once(process.stdout, "drain");
  }
}
