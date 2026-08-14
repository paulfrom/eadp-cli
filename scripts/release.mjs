import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const dryRun = arguments_.includes("--dry-run");
const releaseArguments = arguments_.filter((argument) => argument !== "--dry-run");
if (releaseArguments.length > 1) {
  throw new Error("发布脚本只接受一个版本参数：patch、minor、major 或明确版本号");
}

const releaseVersion = releaseArguments[0] ?? "patch";
const npm = npmInvocation();

if (!dryRun) {
  runNpm(["version", releaseVersion, "--no-git-tag-version"]);
}

const packageJson = await readPackageJson();
process.stdout.write(`准备发布 ${packageJson.name}@${packageJson.version}\n`);

runNpm(["run", "check"]);
runNpm(["pack", "--ignore-scripts"]);
runNpm(["run", "test:package"]);
runNpm(["publish", "--ignore-scripts", "--dry-run"]);

process.stdout.write(
  dryRun
    ? "Dry run 完成，未发布到 npm。\n"
    : `${packageJson.name}@${packageJson.version} 已发布到 npm。\n`
);

async function readPackageJson() {
  return JSON.parse(await readFile(resolve("package.json"), "utf8"));
}

function npmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath],
      shell: false
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [],
    shell: process.platform === "win32"
  };
}

function runNpm(arguments_) {
  const result = spawnSync(npm.command, [...npm.args, ...arguments_], {
    encoding: "utf8",
    shell: npm.shell
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(
      `命令执行失败：npm ${arguments_.join(" ")}\n${result.stderr || result.stdout || result.error?.message || "未知错误"
      }`
    );
  }
}
