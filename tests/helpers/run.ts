/**
 * 统一命令执行与输出捕获辅助。
 */
import { vi } from "vitest";
import type { Command } from "commander";
import { MockEadpServer } from "./server.js";

export interface CapturedOutput {
  text(): string;
  clear(): void;
  restore(): void;
  /** 将 stdout 按行解析为 JSON 值（默认每行一个 JSON）。 */
  lines(): unknown[];
}

/** 捕获 process.stdout.write 的输出。 */
export function captureOutput(): CapturedOutput {
  let value = "";
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      value += String(chunk);
      return true;
    });
  return {
    text: () => value,
    clear: () => {
      value = "";
    },
    restore: () => write.mockRestore(),
    lines: () =>
      value
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
  };
}

/** 执行命令并返回 stdout 文本；命令抛错时测试失败。 */
export async function runCommand(program: Command, argv: string[]): Promise<string> {
  const output = captureOutput();
  try {
    await program.parseAsync(argv, { from: "user" });
    return output.text();
  } finally {
    output.restore();
  }
}

/** 执行命令并断言失败，返回错误消息文本。 */
export async function runExpectError(program: Command, argv: string[]): Promise<string> {
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`命令应当失败：eadp ${argv.join(" ")}`);
}

/** 断言指定服务器上没有任何满足条件的写入请求（零写入）。 */
export function expectNoWrites(server: MockEadpServer, pathMatcher?: string | RegExp): void {
  const writes = server.requests.filter((request) => {
    if (request.method === "GET") return false;
    if (pathMatcher === undefined) return true;
    return typeof pathMatcher === "string"
      ? request.path === pathMatcher
      : pathMatcher.test(request.path);
  });
  if (writes.length > 0) {
    throw new Error(
      `预期零写入，但收到 ${writes.length} 个写请求：${writes
        .map((request) => `${request.method} ${request.path}`)
        .join(", ")}`
    );
  }
}
