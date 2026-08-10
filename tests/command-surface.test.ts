import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";

describe("统一命令面", () => {
  it("只暴露动词优先的业务命令和全局运行参数", () => {
    const help = createProgram().helpInformation();

    for (const command of [
      "inspect",
      "query",
      "call",
      "apply",
      "assign",
      "revoke",
      "sync",
      "verify"
    ]) {
      expect(help).toContain(command);
    }

    expect(help).toContain("--timeout <ms>");
    expect(help).toContain("--compact");
    for (const legacyCommand of [
      "request",
      "resource",
      "api",
      "bpm",
      "permission"
    ]) {
      expect(help).not.toMatch(new RegExp(`^\\s+${legacyCommand}\\b`, "m"));
    }
  });

  it("拒绝无效的全局超时时间", async () => {
    const program = createProgram().exitOverride();
    await expect(
      program.parseAsync(
        ["--timeout", "invalid", "inspect", "api"],
        { from: "user" }
      )
    ).rejects.toThrow("超时时间无效：invalid");
  });

  it("在业务命令前后都接受 --compact 并压缩只读输出", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["--compact", "inspect", "resource"], {
      from: "user"
    });
    await createProgram().parseAsync(["inspect", "resource", "--compact"], {
      from: "user"
    });

    const text = output.mock.calls.map(([value]) => String(value)).join("");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("{") && line.endsWith("}"))).toBe(true);
    expect(text).not.toContain("\n  ");
    output.mockRestore();
  });
});
