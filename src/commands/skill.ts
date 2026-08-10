import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CliError } from "../errors.js";
import { printValue } from "../io.js";
import { getRuntimeOptions } from "../runtime-options.js";

const skillName = "eadp-operator";
type SkillHost = "codex" | "workbuddy" | "claude" | "qoder";

interface SkillTarget {
  host: SkillHost;
  directory: string;
  manifest: string;
}

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
    .description("为 Codex、WorkBuddy、Claude 和 Qoder 安装或升级 EADP AI Skill");

  skill
    .command("install")
    .description("安装内置 Skill，并自动同步到已发现的 AI 平台")
    .action(async () => {
      await syncSkill("install", getRuntimeOptions(program).compact);
    });

  skill
    .command("upgrade")
    .description("升级已发现 AI 平台中安装的 Skill")
    .action(async () => {
      await syncSkill("upgrade", getRuntimeOptions(program).compact);
    });
}

async function syncSkill(
  operation: "install" | "upgrade",
  compact: boolean
): Promise<void> {
  const sourceManifest = join(bundledSkillDirectory, "SKILL.md");
  await assertBundledSkill(sourceManifest);
  const discoveredTargets = await resolveSkillTargets();
  let targets = discoveredTargets;

  if (operation === "upgrade") {
    targets = [];
    for (const target of discoveredTargets) {
      if (await pathExists(target.manifest)) {
        targets.push(target);
      }
    }
    if (targets.length === 0) {
      throw new CliError("Skill 尚未安装，请先运行 eadp skill install");
    }
  }

  for (const target of targets) {
    await mkdir(dirname(target.directory), { recursive: true });
    await cp(bundledSkillDirectory, target.directory, {
      recursive: true,
      force: true
    });

    const installedManifest = await readFile(target.manifest, "utf8");
    if (!installedManifest.includes(`name: ${skillName}`)) {
      throw new CliError(`${skillName} Skill 安装后校验失败：${target.host}`);
    }
  }

  printValue(
    {
      success: true,
      skill: skillName,
      operation,
      installations: targets.map((target) => ({
        host: target.host,
        directory: target.directory
      }))
    },
    compact
  );
}

async function resolveSkillTargets(): Promise<SkillTarget[]> {
  const codexRoot = resolve(
    process.env.CODEX_HOME || join(homedir(), ".codex")
  );
  const targets = [createTarget("codex", codexRoot)];
  const optionalHosts: Array<{
    host: Exclude<SkillHost, "codex">;
    environment: string;
    defaultDirectory: string;
  }> = [
    { host: "workbuddy", environment: "WORKBUDDY_HOME", defaultDirectory: ".workbuddy" },
    { host: "claude", environment: "CLAUDE_HOME", defaultDirectory: ".claude" },
    { host: "qoder", environment: "QODER_HOME", defaultDirectory: ".qoder" }
  ];
  for (const item of optionalHosts) {
    const configuredRoot = process.env[item.environment];
    const root = resolve(configuredRoot || join(homedir(), item.defaultDirectory));
    if (configuredRoot || (await pathExists(root))) {
      targets.push(createTarget(item.host, root));
    }
  }
  return targets;
}

function createTarget(host: SkillHost, root: string): SkillTarget {
  const directory = join(root, "skills", skillName);
  return {
    host,
    directory,
    manifest: join(directory, "SKILL.md")
  };
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}
