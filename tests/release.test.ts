import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const releaseScript = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("release 发布脚本", () => {
  it("预演不检查登录、不修改版本，只模拟发布", async () => {
    const release = await runRelease(["minor", "--dry-run"], true);

    expect(release.result.status).toBe(0);
    expect(release.commands).toEqual([
      ["run", "check"],
      ["pack", "--ignore-scripts"],
      ["run", "test:package"],
      ["publish", "--ignore-scripts", "--dry-run"]
    ]);
    expect(release.packageJson.version).toBe("0.13.5");
    expect(release.result.stdout).toContain("Dry run 完成，未发布到 npm。");
  });

  it("正式发布先检查登录，再升级版本并实际发布", async () => {
    const release = await runRelease(["patch"]);

    expect(release.result.status).toBe(0);
    expect(release.commands).toEqual([
      ["whoami"],
      ["version", "patch", "--no-git-tag-version"],
      ["run", "check"],
      ["pack", "--ignore-scripts"],
      ["run", "test:package"],
      ["publish", "--ignore-scripts"]
    ]);
    expect(release.packageJson.version).toBe("0.13.6");
    expect(release.result.stdout).toContain("eadp-cli@0.13.6 已发布到 npm。");
  });

  it("登录失败时不修改版本或执行后续发布步骤", async () => {
    const release = await runRelease(["patch"], true);

    expect(release.result.status).not.toBe(0);
    expect(release.commands).toEqual([["whoami"]]);
    expect(release.packageJson.version).toBe("0.13.5");
    expect(release.result.stderr).toContain("命令执行失败：npm whoami");
  });
});

async function runRelease(arguments_: string[], authenticationFails = false) {
  const cwd = await mkdtemp(join(tmpdir(), "eadp-release-"));
  temporaryDirectories.push(cwd);
  const packagePath = join(cwd, "package.json");
  const npmLog = join(cwd, "npm-commands.jsonl");
  const fakeNpm = join(cwd, "fake-npm.mjs");
  await writeFile(packagePath, JSON.stringify({ name: "eadp-cli", version: "0.13.5" }));
  await writeFile(fakeNpm, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TEST_NPM_LOG, JSON.stringify(arguments_) + "\\n");
if (arguments_[0] === "whoami" && process.env.RELEASE_TEST_AUTH_FAILS === "true") {
  process.stderr.write("not logged in\\n");
  process.exit(1);
}
if (arguments_[0] === "version") {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  packageJson.version = "0.13.6";
  writeFileSync("package.json", JSON.stringify(packageJson));
}
`);

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_execpath")
  );
  const result = spawnSync(process.execPath, [releaseScript, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      npm_execpath: fakeNpm,
      RELEASE_TEST_NPM_LOG: npmLog,
      RELEASE_TEST_AUTH_FAILS: String(authenticationFails)
    }
  });
  const commands = (await readFile(npmLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version: string };
  return { result, commands, packageJson };
}
