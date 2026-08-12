import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const installationDirectory = await mkdtemp(join(tmpdir(), "eadp-cli-package-"));
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("无法定位 npm CLI 入口");
}
const packagePath = process.argv[2]
  ? resolve(process.argv[2])
  : createCurrentPackage(npmCliPath);

try {
  const installation = spawnSync(
    process.execPath,
    [
      npmCliPath,
      "install",
      "--prefix",
      installationDirectory,
      "--ignore-scripts",
      packagePath
    ],
    {
      encoding: "utf8"
    }
  );
  if (installation.status !== 0) {
    throw new Error(`安装 npm 包失败：${installation.stderr || installation.stdout}`);
  }

  const executable =
    process.platform === "win32"
      ? join(installationDirectory, "node_modules", ".bin", "eadp.cmd")
      : join(installationDirectory, "node_modules", ".bin", "eadp");
  await access(executable);
  const executableDirectory = join(installationDirectory, "node_modules", ".bin");
  const codexHome = join(installationDirectory, "codex-home");
  const workbuddyHome = join(installationDirectory, "workbuddy-home");
  const claudeHome = join(installationDirectory, "claude-home");
  const qoderHome = join(installationDirectory, "qoder-home");
  await access(
    join(
      installationDirectory,
      "node_modules",
      "eadp-cli",
      "skills",
      "eadp-operator",
      "SKILL.md"
    )
  );
  const helpCases = [
    {
      args: ["--help"],
      expected: [
        "EADP 多环境 API 命令行工具",
        "inspect",
        "query",
        "call",
        "apply",
        "assign",
        "revoke",
        "sync",
        "verify",
        "rollback",
        "--timeout <ms>",
        "--compact",
        "update"
      ]
    },
    {
      args: ["env", "--help"],
      expected: ["管理 EADP 环境", "add", "list", "remove"]
    },
    {
      args: ["inspect", "api", "--help"],
      expected: ["查看接口目录", "--domain", "--domains"]
    },
    {
      args: ["call", "--help"],
      expected: ["<id-or-method>", "[path]", "--dry-run"]
    },
    {
      args: ["inspect", "bpm", "--help"],
      expected: ["从真实项目代码发现 BPM 流程骨架及可选集成回调", "无需 YAML 或 BPM 登记册"]
    },
    {
      args: ["inspect", "permission", "functional", "--help"],
      expected: ["汇总应用、功能项、菜单、角色组和功能角色"]
    },
    {
      args: ["inspect", "permission", "users", "--help"],
      expected: ["最终有效权限", "--feature <code>"]
    },
    {
      args: ["query", "--help"],
      expected: ["--entity-class <name>", "CODE_TYPE", "query menu"]
    },
    {
      args: ["apply", "menu", "--help"],
      expected: ["--parent-code <code>", "--feature-code <code>", "--apply", "operationId"]
    },
    {
      args: ["apply", "functional-role", "--help"],
      expected: ["功能角色代码", "--apply"]
    },
    {
      args: ["apply", "feature", "--help"],
      expected: [
        "--code <code>",
        "--app <code-or-name-or-id>",
        "--feature-type <type>",
        "Operate",
        "Business",
        "Page",
        "global",
        "--apply"
      ]
    },
    {
      args: ["assign", "role", "--help"],
      expected: ["授权主体类型", "--role-type"]
    },
    {
      args: ["revoke", "role", "--help"],
      expected: ["授权主体类型", "--role-type"]
    },
    {
      args: ["verify", "--help"],
      expected: ["按账号、员工号或员工姓名回查角色", "--employee-code", "--menu"]
    },
    {
      args: ["sync", "--help"],
      expected: [
        "注册资源名",
        "feature-group",
        "sync menu",
        "--source",
        "--target",
        "--code <code>",
        "--apply",
        "ConfigType: CODE_TYPE, BAR_TYPE",
        "CycleStrategy: MAX_CYCLE, DAY_CYCLE, MONTH_CYCLE, YEAR_CYCLE",
        "ReturnStrategy: NEW, REPEAT, PATCH",
        "LinkCharacter: EMPTY, DASH, DOT, PIPE, COLON",
        "DefaultElement: FIXED_CODE, DATE_CODE, SERIAL_CODE"
      ]
    },
    {
      args: ["rollback", "--help"],
      expected: ["<operation-id...>", "completedAt 从新到旧", "不要求 --apply"]
    },
    {
      args: ["inspect", "resource", "feature-group"],
      expected: ["eadp.resource.catalog.v1", "feature-group", "featureGroup", "code", "appModuleId"]
    },
    {
      args: ["skill", "--help"],
      expected: ["Codex、WorkBuddy、Claude 和 Qoder", "install", "upgrade"]
    }
  ];
  for (const helpCase of helpCases) {
    const help = spawnSync(
      process.platform === "win32" ? "eadp.cmd" : executable,
      helpCase.args,
      {
        cwd: executableDirectory,
        encoding: "utf8",
        shell: process.platform === "win32"
      }
    );
    if (
      help.status !== 0 ||
      helpCase.expected.some((text) => !help.stdout.includes(text))
    ) {
      throw new Error(
        `npm 命令入口验证失败：eadp ${helpCase.args.join(" ")}\n${
          help.stderr || help.stdout
        }`
      );
    }
  }

  const skillEnvironment = {
    ...process.env,
    CODEX_HOME: codexHome,
    WORKBUDDY_HOME: workbuddyHome,
    CLAUDE_HOME: claudeHome,
    QODER_HOME: qoderHome
  };
  for (const args of [["skill", "install"], ["skill", "upgrade"]]) {
    const skill = spawnSync(
      process.platform === "win32" ? "eadp.cmd" : executable,
      args,
      {
        cwd: executableDirectory,
        encoding: "utf8",
        env: skillEnvironment,
        shell: process.platform === "win32"
      }
    );
    if (
      skill.status !== 0 ||
      !skill.stdout.includes('"success": true') ||
      !skill.stdout.includes('"host": "codex"') ||
      !skill.stdout.includes('"host": "workbuddy"') ||
      !skill.stdout.includes('"host": "claude"') ||
      !skill.stdout.includes('"host": "qoder"')
    ) {
      throw new Error(
        `npm 包 Skill 命令验证失败：eadp ${args.join(" ")}\n${
          skill.stderr || skill.stdout
        }`
      );
    }
  }
  await access(join(codexHome, "skills", "eadp-operator", "SKILL.md"));
  await access(join(workbuddyHome, "skills", "eadp-operator", "SKILL.md"));
  await access(join(claudeHome, "skills", "eadp-operator", "SKILL.md"));
  await access(join(qoderHome, "skills", "eadp-operator", "SKILL.md"));

  if (process.env.EADP_LIVE_FEATURE_TEST === "1") {
    const liveTest = spawnSync(
      process.execPath,
      [resolve("scripts", "live-feature-pagination-test.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EADP_EXECUTABLE: executable
        }
      }
    );
    if (liveTest.status !== 0) {
      throw new Error(
        `开发环境功能项分页验证失败：${liveTest.stderr || liveTest.stdout}`
      );
    }
    process.stdout.write(liveTest.stdout);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        package: packagePath,
        executable: "eadp",
        isolatedInstall: true
      },
      null,
      2
    )}\n`
  );
} finally {
  await rm(installationDirectory, { recursive: true, force: true });
}

function createCurrentPackage(npmCliPath) {
  const packed = spawnSync(process.execPath, [npmCliPath, "pack", "--silent"], {
    encoding: "utf8"
  });
  if (packed.status !== 0) {
    throw new Error(`生成 npm 包失败：${packed.stderr || packed.stdout}`);
  }
  const archive = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!archive) {
    throw new Error("npm pack 未返回包文件名");
  }
  return resolve(archive);
}
