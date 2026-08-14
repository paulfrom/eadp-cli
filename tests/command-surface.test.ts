import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";

describe("统一命令面", () => {
  it("暴露 resource-first 资源命令和领域命令及全局运行参数", () => {
    const program = createProgram();
    const help = program.helpInformation();
    for (const command of ["permission", "bpm", "menu", "resource", "rollback", "env", "skill", "update"]) {
      expect(help).toContain(command);
    }
    expect(program.commands.map((command) => command.name())).not.toEqual(
      expect.arrayContaining(["inspect", "call"])
    );
    expect(help).not.toMatch(/^\s+(inspect|call)\b/m);
    expect(help).toContain("--timeout <ms>");
    expect(help).toContain("--compact");
    expect(help).toContain("--output <format>");
    expect(help).toContain("compact-ndjson");
    for (const legacyCommand of ["request", "api", "apply", "assign", "revoke", "verify"]) {
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
      program.parseAsync(["--timeout", "invalid", "resource", "list"], { from: "user" })
    ).rejects.toThrow("超时时间无效：invalid");
  });

  it("resource list/describe 提供资源发现与契约详情", async () => {
    let outputText = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outputText += String(chunk);
      return true;
    });
    try {
      await createProgram().parseAsync(["resource", "list"], { from: "user" });
      await createProgram().parseAsync(["resource", "describe", "feature"], { from: "user" });
    } finally {
      output.mockRestore();
    }
    expect(outputText).toContain('"kind": "eadp.resource.catalog.v2"');
    expect(outputText).toContain('"name": "feature"');
    expect(outputText).toContain('"kind": "eadp.resource.contract.v1"');
    expect(outputText).toContain('"identityFields"');
  });

  it("env add 帮助明确仅支持管理员权限策略", () => {
    const env = createProgram().commands.find((command) => command.name() === "env");
    const add = env?.commands.find((command) => command.name() === "add");
    expect(add?.description()).toContain("GlobalAdmin");
    expect(add?.description()).toContain("TenantAdmin");
  });

  it("在业务命令前后都接受 --compact 并压缩只读输出", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram().parseAsync(["--compact", "resource", "list"], { from: "user" });
      await createProgram().parseAsync(["resource", "list", "--compact"], { from: "user" });
      const text = output.mock.calls.map(([value]) => String(value)).join("");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.startsWith("{") && line.endsWith("}"))).toBe(true);
      expect(text).not.toContain("\n  ");
    } finally {
      output.mockRestore();
    }
  });

  it("在业务命令前后都接受 --output compact-ndjson 并输出 meta/row", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram().parseAsync(["--output", "compact-ndjson", "resource", "list"], { from: "user" });
      await createProgram().parseAsync(["resource", "list", "--output", "compact-ndjson"], { from: "user" });
      const lines = output.mock.calls
        .map(([value]) => String(value))
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.filter((line) => line.type === "meta")).toHaveLength(2);
      expect(lines.every((line) =>
        line.type === "row" || (line.type === "meta" && Array.isArray(line.schema))
      )).toBe(true);
    } finally {
      output.mockRestore();
    }
  });
});
