/**
 * skill / update 必测矩阵：
 * - skill install/upgrade 覆盖 Codex、WorkBuddy、Claude、Qoder 四个平台
 * - update：npm 升级失败立即停止，不执行 Skill 操作
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { createProgram } from "../src/program.js";
import { updateCliAndSkill } from "../src/commands/update.js";
import { cleanupAll, trackDirectory } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
  vi.restoreAllMocks();
});

type HomeEnv = "CODEX_HOME" | "WORKBUDDY_HOME" | "CLAUDE_HOME" | "QODER_HOME";

function withHomes(homes: Record<HomeEnv, string>, action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(
    (Object.keys(homes) as HomeEnv[]).map((name) => [name, process.env[name]])
  ) as Record<HomeEnv, string | undefined>;
  for (const [name, value] of Object.entries(homes)) {
    process.env[name as HomeEnv] = value;
  }
  return action().finally(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name as HomeEnv];
      else process.env[name as HomeEnv] = value;
    }
  });
}

async function makeHomes(): Promise<Record<HomeEnv, string>> {
  const names: HomeEnv[] = ["CODEX_HOME", "WORKBUDDY_HOME", "CLAUDE_HOME", "QODER_HOME"];
  const homes = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await mkdtemp(join(tmpdir(), `eadp-${name.toLowerCase()}-`))]))
  ) as Record<HomeEnv, string>;
  for (const home of Object.values(homes)) trackDirectory(home);
  return homes;
}

describe("skill install / upgrade：四个平台", () => {
  it("install 同时安装到 Codex、WorkBuddy、Claude 与 Qoder 的用户级 skills 目录", async () => {
    const homes = await makeHomes();
    await withHomes(homes, async () => {
      await createProgram().parseAsync(["skill", "install"], { from: "user" });
    });
    for (const home of Object.values(homes)) {
      await expect(
        readFile(join(home, "skills", "eadp-operator", "SKILL.md"), "utf8")
      ).resolves.toContain("name: eadp-operator");
    }
  });

  it("upgrade 只升级已安装 Skill 的平台，未安装平台不创建目录", async () => {
    const homes = await makeHomes();
    const workbuddyTarget = join(homes.WORKBUDDY_HOME, "skills", "eadp-operator");
    await mkdir(workbuddyTarget, { recursive: true });
    await writeFile(join(workbuddyTarget, "SKILL.md"), "旧版本 Skill", "utf8");
    await withHomes(homes, async () => {
      await createProgram().parseAsync(["skill", "upgrade"], { from: "user" });
    });
    await expect(readFile(join(workbuddyTarget, "SKILL.md"), "utf8"))
      .resolves.toContain("name: eadp-operator");
    await expect(
      readFile(join(homes.CODEX_HOME, "skills", "eadp-operator", "SKILL.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("所有平台都未安装时 upgrade 失败并提示先安装", async () => {
    const homes = await makeHomes();
    await withHomes(homes, async () => {
      await expect(
        createProgram().parseAsync(["skill", "upgrade"], { from: "user" })
      ).rejects.toThrow("Skill 尚未安装，请先运行 eadp skill install");
    });
  });

  it("Claude 与 Qoder 使用各自用户级目录，不混用平台根目录", async () => {
    const homes = await makeHomes();
    await withHomes(homes, async () => {
      await createProgram().parseAsync(["skill", "install"], { from: "user" });
    });
    await expect(
      readFile(join(homes.CLAUDE_HOME, "skills", "eadp-operator", "SKILL.md"), "utf8")
    ).resolves.toContain("name: eadp-operator");
    await expect(
      readFile(join(homes.QODER_HOME, "skills", "eadp-operator", "SKILL.md"), "utf8")
    ).resolves.toContain("name: eadp-operator");
  });
});

describe("update：npm 升级失败立即停止", () => {
  function runnerMock(
    calls: Array<{ command: string; args: string[] }>,
    sequence: Array<{ stdout?: string; status?: number; stderr?: string }>
  ): (command: string, args: string[], options?: SpawnSyncOptions) => SpawnSyncReturns<string> {
    let index = 0;
    return vi.fn((command, args) => {
      calls.push({ command, args });
      const step = sequence[Math.min(index++, sequence.length - 1)]!;
      return spawnResult(step.stdout ?? "", step.status ?? 0, step.stderr ?? "");
    });
  }

  it("先升级 npm CLI，再使用升级后的 CLI 安装 Skill，并返回当前版本", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = runnerMock(calls, [
      { stdout: "" },
      { stdout: "C:\\Users\\tester\\AppData\\Roaming\\npm" },
      { stdout: "0.9.7\n" },
      { stdout: '{"success":true}' }
    ]);
    let text = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    try {
      await updateCliAndSkill(runner);
    } finally {
      output.mockRestore();
    }
    expect(calls[0]?.args.slice(-3)).toEqual(["install", "--global", "eadp-cli@latest"]);
    expect(calls[2]).toMatchObject({
      command: "C:\\Users\\tester\\AppData\\Roaming\\npm\\eadp.cmd",
      args: ["--version"]
    });
    expect(calls[3]).toMatchObject({
      command: "C:\\Users\\tester\\AppData\\Roaming\\npm\\eadp.cmd",
      args: ["skill", "install"]
    });
    expect(text).toContain('"version": "0.9.7"');
  });

  it("npm 升级失败立即停止，不执行任何 Skill 操作", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = runnerMock(calls, [
      { stdout: "", status: 1, stderr: "registry unavailable" }
    ]);
    await expect(updateCliAndSkill(runner)).rejects.toThrow(
      "升级 eadp-cli 失败：registry unavailable；未执行 Skill 操作"
    );
    expect(calls).toHaveLength(1);
  });

  it("Skill 操作失败时报告 CLI 已升级的部分成功状态", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = runnerMock(calls, [
      { stdout: "" },
      { stdout: "C:\\Users\\tester\\AppData\\Roaming\\npm" },
      { stdout: "0.9.7\n" },
      { stdout: "", status: 1, stderr: "skill permission denied" }
    ]);
    await expect(updateCliAndSkill(runner)).rejects.toThrow(
      "eadp-cli 已升级，但 升级 eadp-operator Skill 失败：skill permission denied"
    );
    expect(calls).toHaveLength(4);
  });
});

function spawnResult(
  stdout: string,
  status = 0,
  stderr = ""
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr, status, signal: null };
}
