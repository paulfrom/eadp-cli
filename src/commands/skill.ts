import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";

const skillName = "eadp-operator";
const bundledSkillDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  skillName
);

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("安装或升级 EADP AI Skill");

  skill
    .command("install")
    .description("安装内置的 eadp-operator Skill")
    .action(async () => {
      await syncSkill("install");
    });

  skill
    .command("upgrade")
    .description("升级已安装的 eadp-operator Skill")
    .action(async () => {
      await syncSkill("upgrade");
    });
}

async function syncSkill(operation: "install" | "upgrade"): Promise<void> {
  const sourceManifest = join(bundledSkillDirectory, "SKILL.md");
  await assertBundledSkill(sourceManifest);

  const codexRoot = resolve(
    process.env.CODEX_HOME || join(homedir(), ".codex")
  );
  const targetDirectory = join(codexRoot, "skills", skillName);
  const targetManifest = join(targetDirectory, "SKILL.md");

  if (operation === "upgrade") {
    try {
      await access(targetManifest);
    } catch (error) {
      if (isMissingPath(error)) {
        throw new CliError("Skill 尚未安装，请先运行 eadp skill install");
      }
      throw error;
    }
  }

  await mkdir(dirname(targetDirectory), { recursive: true });
  await cp(bundledSkillDirectory, targetDirectory, {
    recursive: true,
    force: true
  });

  const installedManifest = await readFile(targetManifest, "utf8");
  if (!installedManifest.includes(`name: ${skillName}`)) {
    throw new CliError(`${skillName} Skill 安装后校验失败`);
  }

  printValue({
    success: true,
    skill: skillName,
    operation,
    installation: targetDirectory
  });
}

async function assertBundledSkill(manifestPath: string): Promise<void> {
  try {
    await access(manifestPath);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new CliError(`内置 Skill 不存在：${skillName}`);
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
