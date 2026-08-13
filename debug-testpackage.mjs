import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const installationDirectory = await mkdtemp(join(tmpdir(), "eadp-cli-dbg-"));
const npmCliPath = process.env.npm_execpath;

function createCurrentPackage() {
  const packed = spawnSync(process.execPath, [npmCliPath, "pack", "--silent"], { encoding: "utf8" });
  console.error("[dbg] pack status:", packed.status);
  const archive = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  console.error("[dbg] archive resolved:", JSON.stringify(archive));
  return resolve(archive);
}

try {
  const packagePath = createCurrentPackage();
  const installation = spawnSync(process.execPath, [npmCliPath, "install", "--prefix", installationDirectory, "--ignore-scripts", packagePath], { encoding: "utf8" });
  console.error("[dbg] install status:", installation.status);

  // Inspect the installed package BEFORE any junction tricks.
  const installedPkg = JSON.parse(await readFile(join(installationDirectory, "node_modules", "eadp-cli", "package.json"), "utf8"));
  console.error("[dbg] installed package.json version:", installedPkg.version);

  const executableDirectory = join(installationDirectory, "node_modules", ".bin");

  const verBefore = spawnSync("eadp.cmd", ["--version"], { cwd: executableDirectory, encoding: "utf8", shell: true });
  console.error("[dbg] BEFORE junction version:", JSON.stringify(verBefore.stdout?.trim()), "status:", verBefore.status);

  const alternateNodeModules = join(installationDirectory, "alternate-node_modules");
  const alternateExecutableDirectory = join(alternateNodeModules, ".bin");
  await symlink(join(installationDirectory, "node_modules"), alternateNodeModules, "junction");

  const ver = spawnSync("eadp.cmd", ["--version"], { cwd: executableDirectory, encoding: "utf8", shell: true });
  console.error("[dbg] AFTER junction version:", JSON.stringify(ver.stdout?.trim()), "status:", ver.status);

  // What does version.ts actually resolve inside the installed package?
  const versionJs = join(installationDirectory, "node_modules", "eadp-cli", "dist", "version.js");
  console.error("[dbg] version.js exists:", (await access(versionJs).then(() => true).catch(() => false)));
  if (await access(versionJs).then(() => true).catch(() => false)) {
    const src = await readFile(versionJs, "utf8");
    console.error("[dbg] version.js snippet:", src.slice(0, 200).replace(/\n/g, " "));
  }
} finally {
  await rm(installationDirectory, { recursive: true, force: true });
}
