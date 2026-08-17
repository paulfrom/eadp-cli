import { describe, expect, it, vi } from "vitest";
import { createProgram, main } from "../src/program.js";
import { CliError, renderCliError } from "../src/errors.js";

describe("统一命令面", () => {
  it("错误渲染为机器可消费的结构化信封", () => {
    const error = new CliError("环境不存在：foo", 1, {
      code: "ENVIRONMENT_UNKNOWN",
      candidates: ["dev", "test"],
      requiredInput: "environment"
    });
    expect(renderCliError(error)).toEqual({
      success: false,
      code: "ENVIRONMENT_UNKNOWN",
      message: "环境不存在：foo",
      candidates: ["dev", "test"],
      requiredInput: "environment"
    });
    expect(renderCliError(new Error("boom"))).toEqual({
      success: false,
      code: "INTERNAL_ERROR",
      message: "boom"
    });
    const plain = new CliError("普通错误");
    expect(renderCliError(plain)).toEqual({
      success: false,
      code: "CLI_ERROR",
      message: "普通错误"
    });
  });

  it("Commander 参数失败只向 stderr 输出一行 JSON", async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    let stdoutText = "";
    let stderrText = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutText += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrText += String(chunk);
      return true;
    });
    try {
      process.argv = [process.execPath, "eadp", "resource", "query", "feature", "--bogus"];
      await main();
      const lines = stderrText.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        success: false,
        code: "INVALID_ARGUMENT"
      });
      expect(stderrText).not.toContain("Usage:");
      expect(stdoutText).toBe("");
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

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
      program.parseAsync(["--timeout", "invalid", "resource", "inspect"], { from: "user" })
    ).rejects.toThrow("超时时间无效：invalid");
  });

  it("resource inspect 三形态：目录、契约摘要与动作结构化参数", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const run = async (args: string[]): Promise<string> => {
      output.mockClear();
      await createProgram().parseAsync(args, { from: "user" });
      return output.mock.calls.map(([value]) => String(value)).join("");
    };
    try {
      const catalog = await run(["resource", "inspect"]);
      const summary = await run(["resource", "inspect", "feature"]);
      const action = await run(["resource", "inspect", "menu", "compare"]);
      const syncAction = await run(["resource", "inspect", "feature", "sync"]);
      // 目录形态：资源、CLI 版本与可用环境
      expect(catalog).toContain('"kind": "eadp.resource.catalog.v2"');
      expect(catalog).toContain('"cliVersion"');
      expect(catalog).toContain('"environment"');
      expect(catalog).toContain('"name": "feature"');
      // 契约摘要形态：不含传输细节，保留路由所需字段
      expect(summary).toContain('"kind": "eadp.resource.contract.v1"');
      expect(summary).toContain('"identityFields"');
      expect(summary).toContain('"capabilities"');
      expect(summary).toContain('"writableFields"');
      expect(summary).toContain('"rollback"');
      expect(summary).toContain('"deletion"');
      // 动作形态：只含当前资源的动作参数，menu compare 不出现 BPM 的 flow 选择器
      expect(action).toContain('"kind": "eadp.resource.action-schema.v1"');
      expect(action).toContain('"action": "compare"');
      expect(action).toContain('"requiredOptions"');
      expect(action).toContain("--source <env>");
      expect(action).toContain('"selectors"');
      expect(action).toContain('"code"');
      expect(action).not.toContain('"flow"');
      expect(syncAction).toContain('"environment"');
      expect(syncAction).toContain('"tenant"');
      expect(syncAction).toContain('"defaults"');
      expect(syncAction).toContain('"rollback"');
      expect(syncAction).toContain('"deletion"');
    } finally {
      output.mockRestore();
    }
  });

  it("inspect 契约摘要隐藏查询传输细节但保留写入恢复与删除契约", async () => {
    let outputText = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outputText += String(chunk);
      return true;
    });
    try {
      await createProgram().parseAsync(["resource", "inspect", "serial-number"], { from: "user" });
    } finally {
      output.mockRestore();
    }
    expect(outputText).not.toMatch(/"query"\s*:/);
    expect(outputText).not.toMatch(/"save"\s*:/);
    expect(outputText).not.toMatch(/"pagination"\s*:/);
    expect(outputText).not.toMatch(/"read"\s*:/);
    expect(outputText).toMatch(/"rollback"\s*:/);
    expect(outputText).toMatch(/"deletion"\s*:/);
  });

  it("inspect 拒绝未注册资源、未声明能力与无效动作", async () => {
    const program = createProgram().exitOverride();
    await expect(
      program.parseAsync(["resource", "inspect", "nonexistent", "query"], { from: "user" })
    ).rejects.toThrow("尚未注册");
    await expect(
      program.parseAsync(["resource", "inspect", "menu", "write"], { from: "user" })
    ).rejects.toThrow("未声明 write 能力");
    await expect(
      program.parseAsync(["resource", "inspect", "feature", "bogus"], { from: "user" })
    ).rejects.toThrow("不支持的动作");
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
      await createProgram().parseAsync(["--compact", "resource", "inspect"], { from: "user" });
      await createProgram().parseAsync(["resource", "inspect", "--compact"], { from: "user" });
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
      await createProgram().parseAsync(["--output", "compact-ndjson", "resource", "inspect"], { from: "user" });
      await createProgram().parseAsync(["resource", "inspect", "--output", "compact-ndjson"], { from: "user" });
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
