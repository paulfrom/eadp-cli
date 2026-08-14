/**
 * 测试生命周期：跟踪临时目录与 mock 服务器，提供统一清理。
 * 每个测试文件在 afterEach 中调用 cleanupAll()。
 */
import { rm } from "node:fs/promises";
import type { MockEadpServer } from "./server.js";

const directories: string[] = [];
const servers: MockEadpServer[] = [];

/** 登记一个将在清理时递归删除的临时目录。 */
export function trackDirectory(directory: string): void {
  directories.push(directory);
}

/** 登记一个将在清理时关闭的 mock 服务器。 */
export function trackServer(server: MockEadpServer): void {
  servers.push(server);
}

/** 关闭全部 mock 服务器并删除全部临时目录。 */
export async function cleanupAll(): Promise<void> {
  const serverTasks = servers.splice(0).map((server) =>
    server.stop().catch(() => undefined)
  );
  await Promise.all(serverTasks);
  const directoryTasks = directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }).catch(() => undefined)
  );
  await Promise.all(directoryTasks);
}

/** 登记一个临时目录（别名，语义更清晰）。 */
export function useTempDirectory(directory: string): void {
  trackDirectory(directory);
}
