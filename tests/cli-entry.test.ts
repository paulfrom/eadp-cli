import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("CLI 入口", () => {
  it("直接执行 dist/cli.js 时显示帮助", () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "--help"], {
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("EADP 多环境 API 命令行工具");
    expect(result.stdout).not.toContain("account");
    expect(result.stdout).toContain("request");
    expect(result.stdout).toContain("bpm");
  });

  it("通过 npm link 风格的目录链接执行时显示帮助", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-cli-link-"));
    temporaryDirectories.push(directory);
    const linkedPackage = join(directory, "eadp-cli");
    await symlink(process.cwd(), linkedPackage, "junction");

    const result = spawnSync(
      process.execPath,
      [join(linkedPackage, "dist", "cli.js"), "--help"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("EADP 多环境 API 命令行工具");
  });
});
