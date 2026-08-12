import type {
  SpawnSyncOptions,
  SpawnSyncReturns
} from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { updateCliAndSkill } from "../src/commands/update.js";

describe("update 命令", () => {
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
        if (args.at(-1) === "--version") {
          return spawnResult("0.9.7\n");
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
      args: ["--version"]
    });
    expect(calls[3]).toMatchObject({
      command: "C:\\Users\\tester\\AppData\\Roaming\\npm\\eadp.cmd",
      args: ["skill", "install"]
    });
  });

  it("升级成功后返回升级后的当前 CLI 版本号", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      .mockReturnValueOnce(spawnResult("0.9.7\n"))
      .mockReturnValueOnce(spawnResult('{"success":true}'));

    await updateCliAndSkill(runner);

    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"version": "0.9.7"')
    );
    output.mockRestore();
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
      .mockReturnValueOnce(spawnResult("0.9.7\n"))
      .mockReturnValueOnce(spawnResult("", 1, "skill permission denied"));

    await expect(updateCliAndSkill(runner)).rejects.toThrow(
      "eadp-cli 已升级，但 升级 eadp-operator Skill 失败：skill permission denied"
    );
    expect(runner).toHaveBeenCalledTimes(4);
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
