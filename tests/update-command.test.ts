import type {
  SpawnSyncOptions,
  SpawnSyncReturns
} from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { updateCliAndSkill } from "../src/commands/update.js";

describe("update 命令", () => {
  it("在根帮助中暴露 update 命令", () => {
    expect(createProgram().helpInformation()).toContain("update");
  });

  it("先升级 npm CLI，再使用升级后的 CLI 安装或升级 Skill", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: SpawnSyncOptions
        ) => SpawnSyncReturns<string>
      >()
      .mockImplementation((command, args) => {
        calls.push({ command, args });
        if (calls.length === 2) {
          return spawnResult("C:\\Users\\tester\\AppData\\Roaming\\npm");
        }
        return spawnResult('{"success":true}');
      });

    await updateCliAndSkill(runner);

    expect(calls[0]?.args.slice(-3)).toEqual([
      "install",
      "--global",
      "eadp-cli@latest"
    ]);
    expect(calls[1]?.args.slice(-2)).toEqual(["prefix", "--global"]);
    expect(calls[2]).toMatchObject({
      command: "C:\\Users\\tester\\AppData\\Roaming\\npm\\eadp.cmd",
      args: ["skill", "install"]
    });
  });

  it("npm CLI 升级失败时立即停止，不执行 Skill 操作", async () => {
    const runner = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: SpawnSyncOptions
        ) => SpawnSyncReturns<string>
      >()
      .mockReturnValue(spawnResult("", 1, "registry unavailable"));

    await expect(updateCliAndSkill(runner)).rejects.toThrow(
      "升级 eadp-cli 失败：registry unavailable；未执行 Skill 操作"
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("Skill 操作失败时报告 CLI 已升级的部分成功状态", async () => {
    const runner = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: SpawnSyncOptions
        ) => SpawnSyncReturns<string>
      >()
      .mockReturnValueOnce(spawnResult(""))
      .mockReturnValueOnce(
        spawnResult("C:\\Users\\tester\\AppData\\Roaming\\npm")
      )
      .mockReturnValueOnce(spawnResult("", 1, "skill permission denied"));

    await expect(updateCliAndSkill(runner)).rejects.toThrow(
      "eadp-cli 已升级，但 升级 eadp-operator Skill 失败：skill permission denied"
    );
    expect(runner).toHaveBeenCalledTimes(3);
  });
});

function spawnResult(
  stdout: string,
  status = 0,
  stderr = ""
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout,
    stderr,
    status,
    signal: null
  };
}
