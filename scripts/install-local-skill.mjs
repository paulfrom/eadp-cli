import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const skillNames = ["eadp-operator", "eadp-resource-contract"];
const bundledSkillsRoot = resolve("skills");
for (const skillName of skillNames) {
  await access(join(bundledSkillsRoot, skillName, "SKILL.md"));
}

const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const targets = [{ host: "codex", root: codexRoot }];
const optionalHosts = [
  { host: "workbuddy", environment: "WORKBUDDY_HOME", defaultDirectory: ".workbuddy" },
  { host: "claude", environment: "CLAUDE_HOME", defaultDirectory: ".claude" },
  { host: "qoder", environment: "QODER_HOME", defaultDirectory: ".qoder" }
];
for (const item of optionalHosts) {
  const configuredRoot = process.env[item.environment];
  const root = resolve(configuredRoot || join(homedir(), item.defaultDirectory));
  if (configuredRoot || (await pathExists(root))) {
    targets.push({ host: item.host, root });
  }
}

const installations = [];
for (const item of targets) {
  const skillsRoot = join(item.root, "skills");
  await mkdir(skillsRoot, { recursive: true });
  for (const skillName of skillNames) {
    const source = join(bundledSkillsRoot, skillName);
    const target = join(skillsRoot, skillName);
    await cp(source, target, { recursive: true, force: true });

    const installedSkill = await readFile(join(target, "SKILL.md"), "utf8");
    if (!installedSkill.includes(`name: ${skillName}`)) {
      throw new Error(`${skillName} Skill 安装后校验失败：${item.host}`);
    }
    installations.push({ host: item.host, skill: skillName, directory: target });
  }
}

process.stdout.write(
  `${JSON.stringify(
      {
        success: true,
        skills: skillNames,
        installations
      },
    null,
    2
  )}\n`
);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
