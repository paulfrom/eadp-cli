import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("skill 命令", () => {
  it("安装内置 eadp-operator Skill 到 CODEX_HOME", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-install-"));
    temporaryDirectories.push(codexHome);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await createProgram().parseAsync(["skill", "install"], { from: "user" });

      const installedSkill = await readFile(
        join(codexHome, "skills", "eadp-operator", "SKILL.md"),
        "utf8"
      );
      expect(installedSkill).toContain("name: eadp-operator");
    } finally {
      restoreCodexHome(previousCodexHome);
    }
  });

  it("升级已安装的 eadp-operator Skill", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-upgrade-"));
    temporaryDirectories.push(codexHome);
    const target = join(codexHome, "skills", "eadp-operator");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "旧版本 Skill", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await createProgram().parseAsync(["skill", "upgrade"], { from: "user" });

      const upgradedSkill = await readFile(join(target, "SKILL.md"), "utf8");
      expect(upgradedSkill).toContain("name: eadp-operator");
      expect(upgradedSkill).not.toContain("旧版本 Skill");
    } finally {
      restoreCodexHome(previousCodexHome);
    }
  });

  it("未安装 Skill 时升级失败并提示先安装", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-missing-"));
    temporaryDirectories.push(codexHome);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await expect(
        createProgram().parseAsync(["skill", "upgrade"], { from: "user" })
      ).rejects.toThrow("Skill 尚未安装，请先运行 eadp skill install");
    } finally {
      restoreCodexHome(previousCodexHome);
    }
  });
});

function restoreCodexHome(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = value;
  }
}
