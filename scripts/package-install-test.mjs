import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const packagePath = resolve(
  process.argv[2] ?? `eadp-cli-${packageJson.version}.tgz`
);
const installationDirectory = await mkdtemp(join(tmpdir(), "eadp-cli-package-"));
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("无法定位 npm CLI 入口");
}

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
    { args: ["--help"], expected: ["EADP 多环境 API 命令行工具", "resource", "bpm", "permission", "update"] },
    { args: ["env", "--help"], expected: ["管理 EADP 环境", "add", "list"] },
    {
      args: ["permission", "functional", "--help"],
      expected: ["功能项、菜单、功能角色与授权树", "inspect", "apply", "assign"]
    },
    {
      args: ["permission", "verify", "--help"],
      expected: ["按账号、员工号或员工姓名回查角色", "--employee-code", "--menu"]
    },
    {
      args: ["resource", "--help"],
      expected: ["查询资源", "query", "diff", "sync"]
    },
    {
      args: ["permission", "principal", "--help"],
      expected: ["分配给用户", "assign", "revoke"]
    },
    {
      args: ["skill", "--help"],
      expected: ["安装或升级 EADP AI Skill", "install", "upgrade"]
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

  const skillEnvironment = { ...process.env, CODEX_HOME: codexHome };
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
    if (skill.status !== 0 || !skill.stdout.includes('"success": true')) {
      throw new Error(
        `npm 包 Skill 命令验证失败：eadp ${args.join(" ")}\n${
          skill.stderr || skill.stdout
        }`
      );
    }
  }
  await access(join(codexHome, "skills", "eadp-operator", "SKILL.md"));

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
