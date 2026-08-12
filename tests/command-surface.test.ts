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
      "verify",
      "rollback"
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

  it("rollback 帮助明确直接执行且不暴露 --apply", () => {
    const rollback = createProgram().commands.find((command) => command.name() === "rollback");
    let help = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      help += String(chunk);
      return true;
    });
    rollback?.outputHelp();
    expect(help).toContain("不要求 --apply");
    expect(help).not.toMatch(/^\s+--apply\b/m);
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

  it("资源和通用 call 帮助明确四类 global 管理员资源", () => {
    const program = createProgram();
    let help = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      help += String(chunk);
      return true;
    });
    for (const name of ["query", "sync", "call"]) {
      program.commands.find((command) => command.name() === name)?.outputHelp();
    }
    output.mockRestore();
    expect(help).toContain('tenantCode === "global"');
    expect(help).toContain("menu");
    expect(help).toContain("feature");
    expect(help).toContain("feature-group");
    expect(help).toContain("serial-number");
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
