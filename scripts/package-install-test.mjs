import { access, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const alternateNodeModules = process.platform === "win32"
    ? join(installationDirectory, "alternate-node_modules")
    : null;
  const alternateExecutableDirectory = alternateNodeModules
    ? join(alternateNodeModules, ".bin")
    : null;
  if (alternateNodeModules && alternateExecutableDirectory) {
    // npm's Windows shim resolves its target relative to %~dp0. Running the
    // generated shim through a junction keeps that relative path valid while
    // exercising the alternate-path case that previously skipped main().
    await symlink(
      join(installationDirectory, "node_modules"),
      alternateNodeModules,
      "junction"
    );
  }
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
      args: ["--version"],
      expected: [packageJson.version]
    },
    {
      args: ["--help"],
      expected: [
        "EADP 多环境资源与权限命令行工具",
        "permission",
        "menu",
        "bpm",
        "resource",
        "rollback",
        "--timeout <ms>",
        "--compact",
        "update"
      ],
      forbidden: ["inspect", "call"]
    },
    {
      args: ["env", "--help"],
      expected: ["管理 EADP 环境", "add", "list", "remove"]
    },
    {
      args: ["bpm", "inspect", "--help"],
      expected: ["从真实项目代码发现 BPM 流程骨架及可选集成回调", "无需 YAML 或 BPM 登记册"]
    },
    {
      args: ["permission", "inspect", "functional", "--help"],
      expected: ["汇总应用、功能项、菜单、角色组和功能角色"]
    },
    {
      args: ["permission", "inspect", "users", "--help"],
      expected: ["最终有效权限", "--feature <code>"]
    },
    {
      args: ["resource", "query", "--help"],
      expected: ["按资源契约完整查询", "--env <env>", "分页自动聚合"]
    },
    {
      args: ["resource", "list"],
      expected: [
        '"kind": "eadp.resource.catalog.v2"',
        '"name": "feature"',
        '"name": "serial-number"'
      ]
    },
    {
      args: ["resource", "describe", "feature"],
      expected: [
        '"kind": "eadp.resource.contract.v1"',
        '"id": "feature"',
        '"identityFields"',
        '"capabilities"'
      ]
    },
    {
      args: ["menu", "create", "--help"],
      expected: ["--parent-code <code>", "--feature-code <code>", "--apply", "operationId"]
    },
    {
      args: ["permission", "apply", "functional-role", "--help"],
      expected: ["功能角色代码", "--apply"]
    },
    {
      args: ["permission", "apply", "feature", "--help"],
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
      args: ["permission", "assign", "role", "--help"],
      expected: ["授权主体类型", "--role-type"]
    },
    {
      args: ["permission", "assign", "permission", "--help"],
      expected: [
        "复制用户权限",
        "--source-employee-code",
        "--target-employee-code",
        "只新增",
        "公共角色",
        "--apply"
      ]
    },
    {
      args: ["permission", "revoke", "role", "--help"],
      expected: ["授权主体类型", "--role-type"]
    },
    {
      args: ["permission", "verify", "--help"],
      expected: ["按账号、员工号或员工姓名回查角色", "--employee-code", "--menu"]
    },
    {
      args: ["resource", "sync", "--help"],
      expected: [
        "复用 compare change plan",
        "<name>",
        "--source",
        "--target",
        "--apply",
        "blocked"
      ]
    },
    {
      args: ["rollback", "--help"],
      expected: ["<operation-id...>", "completedAt 从新到旧", "不要求 --apply"]
    },
    {
      args: ["resource", "describe", "feature-group"],
      expected: ["eadp.resource.contract.v1", "feature-group", "featureGroup", "code", "appModuleId"]
    },
    {
      args: ["resource", "describe", "serial-number"],
      expected: ["returnStrategy", "NEW", "REPEAT", "PATCH", "configItem[].linkCharacter"]
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
      helpCase.expected.some((text) => !help.stdout.includes(text)) ||
      (helpCase.forbidden ?? []).some(
        (command) => new RegExp(`^\\s+${command}\\b`, "m").test(help.stdout)
      )
    ) {
      throw new Error(
        `npm 命令入口验证失败：eadp ${helpCase.args.join(" ")}\n${
          help.stderr || help.stdout
        }`
      );
    }
  }

  if (alternateExecutableDirectory) {
    const alternateExecutable = join(alternateExecutableDirectory, "eadp.cmd");
    const result = spawnSync(alternateExecutable, ["--version"], {
      cwd: alternateExecutableDirectory,
      encoding: "utf8",
      shell: true
    });
    if (result.status !== 0 || !result.stdout.includes(packageJson.version)) {
      throw new Error(
        `junction npm 命令入口验证失败：eadp --version\n${
          result.stderr || result.stdout || result.error?.message || ""
        }`
      );
    }
  }

  if (process.platform === "win32") {
    // Generate a genuine npm Windows shim for the legacy bin target.
    // This exercises upgrades from installations whose shim still invokes
    // dist/cli.js directly, rather than hand-writing a .cmd fixture.
    const legacyPackageDirectory = join(installationDirectory, "legacy-package");
    const legacyInstallationDirectory = join(
      installationDirectory,
      "legacy-install"
    );
    const installedPackageDirectory = join(
      installationDirectory,
      "node_modules",
      "eadp-cli"
    );
    await cp(installedPackageDirectory, legacyPackageDirectory, {
      recursive: true
    });
    const legacyManifestPath = join(legacyPackageDirectory, "package.json");
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8"));
    legacyManifest.bin = { eadp: "dist/cli.js" };
    await writeFile(
      legacyManifestPath,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
      "utf8"
    );

    const legacyInstallation = spawnSync(
      process.execPath,
      [
        npmCliPath,
        "install",
        "--prefix",
        legacyInstallationDirectory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        legacyPackageDirectory
      ],
      { encoding: "utf8" }
    );
    if (legacyInstallation.status !== 0) {
      throw new Error(
        `安装旧版 npm shim 测试包失败：${
          legacyInstallation.stderr || legacyInstallation.stdout
        }`
      );
    }

    const legacyAlternateNodeModules = join(
      legacyInstallationDirectory,
      "alternate-node_modules"
    );
    await symlink(
      join(legacyInstallationDirectory, "node_modules"),
      legacyAlternateNodeModules,
      "junction"
    );
    const legacyExecutable = join(
      legacyAlternateNodeModules,
      ".bin",
      "eadp.cmd"
    );
    await access(legacyExecutable);
    const legacyShim = await readFile(legacyExecutable, "utf8");
    if (!/dist[\\/]cli\.js/i.test(legacyShim)) {
      throw new Error(
        `旧版 npm shim 未指向 dist/cli.js：${legacyExecutable}\n${legacyShim}`
      );
    }
    const legacyResult = spawnSync(legacyExecutable, ["--version"], {
      cwd: join(legacyAlternateNodeModules, ".bin"),
      encoding: "utf8",
      shell: true
    });
    if (
      legacyResult.status !== 0 ||
      !legacyResult.stdout.includes(packageJson.version)
    ) {
      throw new Error(
        `旧版 junction npm 命令入口验证失败：eadp --version\n${
          legacyResult.stderr ||
          legacyResult.stdout ||
          legacyResult.error?.message ||
          ""
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
