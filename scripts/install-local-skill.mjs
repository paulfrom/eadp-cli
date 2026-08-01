import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve("skills", "eadp-operator");
await access(join(source, "SKILL.md"));

const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const skillsRoot = join(codexRoot, "skills");
const target = join(skillsRoot, "eadp-operator");
await mkdir(skillsRoot, { recursive: true });
await cp(source, target, { recursive: true, force: true });

const installedSkill = await readFile(join(target, "SKILL.md"), "utf8");
if (!installedSkill.includes("name: eadp-operator")) {
  throw new Error("eadp-operator Skill 安装后校验失败");
}

process.stdout.write(
  `${JSON.stringify(
    {
      success: true,
      skill: "eadp-operator",
      installation: target
    },
    null,
    2
  )}\n`
);
