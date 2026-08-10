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
  it("Skill 明确 BPM 配置名称必须从注释总结且不超过十五字", async () => {
    const skill = await readFile(
      join(process.cwd(), "skills", "eadp-operator", "SKILL.md"),
      "utf8"
    );
    const workflow = await readFile(
      join(process.cwd(), "skills", "eadp-operator", "references", "bpm-configuration.md"),
      "utf8"
    );

    expect(skill).toContain("references/bpm-configuration.md");
    expect(workflow).toContain("代码注释");
    expect(workflow).toContain("不超过 15 个字");
    expect(workflow).toContain("XXX流程结束后");
    expect(workflow).toContain("XXX选人");
    expect(workflow).toContain("XXX流程提交前");
    expect(workflow).toContain("CUSTOM_PERSON");
    expect(workflow).toContain("EVENT");
    expect(workflow).toContain("Java return contract");
    expect(workflow).toContain("Explicit BPM intent takes precedence");
    expect(workflow).toContain("Never map a BPM flow name to `feature`");
    expect(workflow).toContain("eadp sync bpm --source");
    expect(workflow).toContain("--flow");
    expect(workflow).toContain("`auditTypeId` and `auditTypeName` to null");
    expect(workflow).not.toContain("dedicated BPM migration command is unavailable");
    expect(skill).toContain("references/serial-number-sync.md");
    const serialWorkflow = await readFile(
      join(process.cwd(), "skills", "eadp-operator", "references", "serial-number-sync.md"),
      "utf8"
    );
    expect(serialWorkflow).toContain("eadp sync serial-number");
    expect(serialWorkflow).toContain("CODE_TYPE");
    expect(serialWorkflow).toContain("entityClassName");
    expect(serialWorkflow).toContain("tenantCode");
    expect(serialWorkflow).toContain("--created-in 2026-08");
    const syncWorkflow = await readFile(
      join(process.cwd(), "skills", "eadp-operator", "references", "resource-sync.md"),
      "utf8"
    );
    expect(syncWorkflow).toContain("--from \"2026-08-01 00:00:00\"");
    expect(syncWorkflow).toContain("--to \"2026-09-01 00:00:00\"");
    expect(syncWorkflow).toContain("create / update / unchanged");
    expect(syncWorkflow).toContain("Existing and different");
    expect(workflow).toContain("does not accept time filters");
  });

  it("安装内置 eadp-operator Skill 到 Codex、WorkBuddy、Claude 和 Qoder", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-install-"));
    const workbuddyHome = await mkdtemp(join(tmpdir(), "eadp-workbuddy-install-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "eadp-claude-install-"));
    const qoderHome = await mkdtemp(join(tmpdir(), "eadp-qoder-install-"));
    temporaryDirectories.push(codexHome, workbuddyHome, claudeHome, qoderHome);
    const previousCodexHome = process.env.CODEX_HOME;
    const previousWorkbuddyHome = process.env.WORKBUDDY_HOME;
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const previousQoderHome = process.env.QODER_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.WORKBUDDY_HOME = workbuddyHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.QODER_HOME = qoderHome;

    try {
      await createProgram().parseAsync(["skill", "install"], { from: "user" });

      const codexSkill = await readFile(
        join(codexHome, "skills", "eadp-operator", "SKILL.md"),
        "utf8"
      );
      const workbuddySkill = await readFile(
        join(workbuddyHome, "skills", "eadp-operator", "SKILL.md"),
        "utf8"
      );
      expect(codexSkill).toContain("name: eadp-operator");
      expect(workbuddySkill).toContain("name: eadp-operator");
      expect(await readFile(join(claudeHome, "skills", "eadp-operator", "SKILL.md"), "utf8"))
        .toContain("name: eadp-operator");
      expect(await readFile(join(qoderHome, "skills", "eadp-operator", "SKILL.md"), "utf8"))
        .toContain("name: eadp-operator");
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
      restoreEnvironment("WORKBUDDY_HOME", previousWorkbuddyHome);
      restoreEnvironment("CLAUDE_HOME", previousClaudeHome);
      restoreEnvironment("QODER_HOME", previousQoderHome);
    }
  });

  it("升级四个平台中已安装的 eadp-operator Skill", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-upgrade-"));
    const workbuddyHome = await mkdtemp(join(tmpdir(), "eadp-workbuddy-upgrade-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "eadp-claude-upgrade-"));
    const qoderHome = await mkdtemp(join(tmpdir(), "eadp-qoder-upgrade-"));
    temporaryDirectories.push(codexHome, workbuddyHome, claudeHome, qoderHome);
    const codexTarget = join(codexHome, "skills", "eadp-operator");
    const workbuddyTarget = join(workbuddyHome, "skills", "eadp-operator");
    const claudeTarget = join(claudeHome, "skills", "eadp-operator");
    const qoderTarget = join(qoderHome, "skills", "eadp-operator");
    await mkdir(codexTarget, { recursive: true });
    await mkdir(workbuddyTarget, { recursive: true });
    await mkdir(claudeTarget, { recursive: true });
    await mkdir(qoderTarget, { recursive: true });
    await writeFile(join(codexTarget, "SKILL.md"), "Codex 旧版本 Skill", "utf8");
    await writeFile(
      join(workbuddyTarget, "SKILL.md"),
      "WorkBuddy 旧版本 Skill",
      "utf8"
    );
    await writeFile(join(claudeTarget, "SKILL.md"), "Claude 旧版本 Skill", "utf8");
    await writeFile(join(qoderTarget, "SKILL.md"), "Qoder 旧版本 Skill", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousWorkbuddyHome = process.env.WORKBUDDY_HOME;
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const previousQoderHome = process.env.QODER_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.WORKBUDDY_HOME = workbuddyHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.QODER_HOME = qoderHome;

    try {
      await createProgram().parseAsync(["skill", "upgrade"], { from: "user" });

      const codexSkill = await readFile(join(codexTarget, "SKILL.md"), "utf8");
      const workbuddySkill = await readFile(
        join(workbuddyTarget, "SKILL.md"),
        "utf8"
      );
      expect(codexSkill).toContain("name: eadp-operator");
      expect(workbuddySkill).toContain("name: eadp-operator");
      expect(codexSkill).not.toContain("旧版本 Skill");
      expect(workbuddySkill).not.toContain("旧版本 Skill");
      expect(await readFile(join(claudeTarget, "SKILL.md"), "utf8"))
        .toContain("name: eadp-operator");
      expect(await readFile(join(qoderTarget, "SKILL.md"), "utf8"))
        .toContain("name: eadp-operator");
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
      restoreEnvironment("WORKBUDDY_HOME", previousWorkbuddyHome);
      restoreEnvironment("CLAUDE_HOME", previousClaudeHome);
      restoreEnvironment("QODER_HOME", previousQoderHome);
    }
  });

  it("升级时只处理已经安装 Skill 的平台", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-partial-codex-"));
    const workbuddyHome = await mkdtemp(
      join(tmpdir(), "eadp-skill-partial-workbuddy-")
    );
    const claudeHome = await mkdtemp(join(tmpdir(), "eadp-claude-partial-"));
    const qoderHome = await mkdtemp(join(tmpdir(), "eadp-qoder-partial-"));
    temporaryDirectories.push(codexHome, workbuddyHome, claudeHome, qoderHome);
    const workbuddyTarget = join(workbuddyHome, "skills", "eadp-operator");
    await mkdir(workbuddyTarget, { recursive: true });
    await writeFile(join(workbuddyTarget, "SKILL.md"), "旧版本 Skill", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousWorkbuddyHome = process.env.WORKBUDDY_HOME;
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const previousQoderHome = process.env.QODER_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.WORKBUDDY_HOME = workbuddyHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.QODER_HOME = qoderHome;

    try {
      await createProgram().parseAsync(["skill", "upgrade"], { from: "user" });

      expect(
        await readFile(join(workbuddyTarget, "SKILL.md"), "utf8")
      ).toContain("name: eadp-operator");
      await expect(
        readFile(join(codexHome, "skills", "eadp-operator", "SKILL.md"), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
      restoreEnvironment("WORKBUDDY_HOME", previousWorkbuddyHome);
      restoreEnvironment("CLAUDE_HOME", previousClaudeHome);
      restoreEnvironment("QODER_HOME", previousQoderHome);
    }
  });

  it("所有平台都未安装 Skill 时升级失败并提示先安装", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "eadp-skill-missing-"));
    const workbuddyHome = await mkdtemp(join(tmpdir(), "eadp-workbuddy-missing-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "eadp-claude-missing-"));
    const qoderHome = await mkdtemp(join(tmpdir(), "eadp-qoder-missing-"));
    temporaryDirectories.push(codexHome, workbuddyHome, claudeHome, qoderHome);
    const previousCodexHome = process.env.CODEX_HOME;
    const previousWorkbuddyHome = process.env.WORKBUDDY_HOME;
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const previousQoderHome = process.env.QODER_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.WORKBUDDY_HOME = workbuddyHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.QODER_HOME = qoderHome;

    try {
      await expect(
        createProgram().parseAsync(["skill", "upgrade"], { from: "user" })
      ).rejects.toThrow("Skill 尚未安装，请先运行 eadp skill install");
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
      restoreEnvironment("WORKBUDDY_HOME", previousWorkbuddyHome);
      restoreEnvironment("CLAUDE_HOME", previousClaudeHome);
      restoreEnvironment("QODER_HOME", previousQoderHome);
    }
  });
});

function restoreEnvironment(
  name: "CODEX_HOME" | "WORKBUDDY_HOME" | "CLAUDE_HOME" | "QODER_HOME",
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
