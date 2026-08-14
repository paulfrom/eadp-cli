import { CliError } from "../../errors.js";
import type {
  SpecialResourceHandler,
  SpecialResourceHandlerEntry,
  SpecialResourceHandlerRegistry
} from "./contracts.js";

export function createSpecialResourceHandlerRegistry(
  entries: readonly SpecialResourceHandlerEntry[]
): SpecialResourceHandlerRegistry {
  const handlers = new Map<string, SpecialResourceHandler>();
  for (const [name, handler] of entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || handlers.has(name)) {
      throw new CliError(`特殊处理器 ID 重复或无效：${name}`);
    }
    handlers.set(name, handler);
  }
  return {
    get(name: string): SpecialResourceHandler {
      const handler = handlers.get(name);
      if (!handler) throw new CliError(`特殊处理器未注册：${name}`);
      return handler;
    },
    find(name: string): SpecialResourceHandler | undefined {
      return handlers.get(name);
    },
    list(): string[] {
      return [...handlers.keys()].sort();
    }
  };
}
