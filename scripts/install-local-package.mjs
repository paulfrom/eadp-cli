import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(
  await readFile(resolve("package.json"), "utf8")
);
const archive = resolve(`eadp-cli-${packageJson.version}.tgz`);
await access(archive);

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("无法定位 npm CLI 入口");
}

run(process.execPath, [
  npmCliPath,
  "install",
  "--global",
  archive
]);

const prefixResult = run(process.execPath, [npmCliPath, "prefix", "--global"]);
const prefix = prefixResult.stdout.trim();
const executable =
  process.platform === "win32" ? join(prefix, "eadp.cmd") : join(prefix, "bin", "eadp");
await access(executable);

const checks = [
  { args: ["--version"], expected: packageJson.version },
  { args: ["env", "--help"], expected: "管理 EADP 环境" },
  {
    args: ["permission", "functional", "--help"],
    expected: "功能项、菜单、功能角色与授权树"
  },
  {
    args: ["permission", "verify", "--help"],
    expected: "--menu"
  },
  {
    args: ["resource", "--help"],
    expected: "按时间和过滤条件查询资源"
  },
  {
    args: ["permission", "principal", "--help"],
    expected: "把功能角色或数据角色分配给用户"
  },
  {
    args: ["update", "--help"],
    expected: "同时升级 eadp CLI 和 AI Skill"
  }
];
for (const check of checks) {
  const result = run(executable, check.args, {
    shell: process.platform === "win32"
  });
  if (!result.stdout.includes(check.expected)) {
    throw new Error(
      `本地安装验证失败：eadp ${check.args.join(" ")}\n${result.stdout}`
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      success: true,
      version: packageJson.version,
      archive,
      installation: "global-package-copy",
      executable
    },
    null,
    2
  )}\n`
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `命令执行失败：${command} ${args.join(" ")}\n${
        result.stderr || result.stdout
      }`
    );
  }
  return result;
}
