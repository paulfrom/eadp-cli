import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const configurationDirectory = await mkdtemp(join(tmpdir(), "eadp-cli-smoke-"));
const cliPath = join(process.cwd(), "dist", "cli.js");
const environment = {
  ...process.env,
  EADP_CONFIG_DIR: configurationDirectory,
  CODEX_HOME: join(configurationDirectory, "codex"),
  EADP_SMOKE_TOKEN: "smoke-secret"
};

try {
  run([
    "env",
    "add",
    "dev",
    "--url",
    "http://10.232.2.126",
    "--token-env",
    "EADP_SMOKE_TOKEN",
    "--default"
  ]);

  const environments = run(["env", "list"]);
  const rootHelp = run(["--help"]);
  const catalog = run(["api", "list", "--domain", "serial-number"]);
  const bpmHelp = run(["bpm", "--help"]);
  const permissionHelp = run(["permission", "--help"]);
  const functionalPermissionHelp = run(["permission", "functional", "--help"]);
  const dataPermissionHelp = run(["permission", "data", "--help"]);
  const principalPermissionHelp = run(["permission", "principal", "--help"]);
  const skillHelp = run(["skill", "--help"]);
  const skillInstall = run(["skill", "install"]);
  const skillUpgrade = run(["skill", "upgrade"]);
  const dryRun = run([
    "api",
    "call",
    "serial-number-config-save",
    "--env",
    "dev",
    "--data",
    JSON.stringify({
      appModuleCode: "BASIC",
      appModuleName: "基础应用",
      entityClassName: "com.example.PositionCategory",
      configType: "CODE_TYPE",
      name: "岗位类别",
      expressionConfig: "#{00000}",
      minNumber: 2,
      maxNumber: 0,
      useDeleted: false,
      cycleStrategy: "MAX_CYCLE",
      activated: true,
      genFlag: true,
      tenantCode: "global",
      publicFlag: true,
      tenantIsolation: true,
      configItem: [
        {
          elementName: "流水号编码",
          elementCode: "SERIAL_CODE",
          elementValue: "5",
          isolation: false,
          linkCharacter: "EMPTY",
          sort: 0
        }
      ]
    }),
    "--dry-run"
  ]);

  if (!catalog.includes("serial-number-config-save")) {
    throw new Error("接口目录烟雾测试失败");
  }
  if (!rootHelp.includes("update")) {
    throw new Error("CLI update 命令帮助烟雾测试失败");
  }
  if (
    !bpmHelp.includes("全新上下文推荐流程") ||
    !bpmHelp.includes("项目无需 YAML")
  ) {
    throw new Error("BPM 自发现帮助烟雾测试失败");
  }
  if (
    !permissionHelp.includes("functional") ||
    !permissionHelp.includes("data") ||
    !permissionHelp.includes("verify") ||
    !functionalPermissionHelp.includes("inspect") ||
    !functionalPermissionHelp.includes("apply") ||
    !functionalPermissionHelp.includes("assign") ||
    !dataPermissionHelp.includes("apply") ||
    !dataPermissionHelp.includes("assign") ||
    !principalPermissionHelp.includes("assign")
  ) {
    throw new Error("权限命令帮助烟雾测试失败");
  }
  if (
    !skillHelp.includes("install") ||
    !skillHelp.includes("upgrade") ||
    !skillInstall.includes('"operation": "install"') ||
    !skillUpgrade.includes('"operation": "upgrade"')
  ) {
    throw new Error("Skill 安装和升级烟雾测试失败");
  }
  if (!dryRun.includes('"x-api-token": "***"')) {
    throw new Error("Dry Run 未正确脱敏 Token");
  }
  if (`${environments}\n${dryRun}`.includes(environment.EADP_SMOKE_TOKEN)) {
    throw new Error("CLI 输出泄露 Token");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        environment: "dev",
        defaultEnvironment: "dev",
        catalog: "serial-number",
        bpmDiscoverable: true,
        permissionDiscoverable: true,
        skillInstallable: true,
        tokenMasked: true
      },
      null,
      2
    )}\n`
  );
} finally {
  await rm(configurationDirectory, { recursive: true, force: true });
}

function run(arguments_) {
  const result = spawnSync(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: environment
  });
  if (result.status !== 0) {
    throw new Error(
      `命令执行失败：eadp ${arguments_.join(" ")}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}
