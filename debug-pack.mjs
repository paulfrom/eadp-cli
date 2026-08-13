import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) throw new Error("no npm_execpath");
console.log("npm_cli:", npmCliPath);
console.log("node:", process.execPath);

const packed = spawnSync(process.execPath, [npmCliPath, "pack", "--silent"], { encoding: "utf8" });
console.log("pack status:", packed.status);
const archive = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
console.log("archive:", JSON.stringify(archive));
const packagePath = resolve(archive);

const dir = await mkdtemp(join(tmpdir(), "eadp-debug-"));
try {
  const inst = spawnSync(process.execPath, [npmCliPath, "install", "--prefix", dir, "--ignore-scripts", packagePath], { encoding: "utf8" });
  console.log("install status:", inst.status);
  if (inst.status !== 0) console.log("install stderr:", inst.stderr?.slice(0, 500));
  const installedPkg = JSON.parse(await readFile(join(dir, "node_modules", "eadp-cli", "package.json"), "utf8"));
  console.log("installed package.json version:", installedPkg.version);
  const exe = join(dir, "node_modules", ".bin", "eadp.cmd");
  const ver = spawnSync(exe, ["--version"], { cwd: join(dir, "node_modules", ".bin"), encoding: "utf8", shell: true });
  console.log("eadp --version:", JSON.stringify(ver.stdout.trim()), "status:", ver.status);
  const verNoShell = spawnSync(exe, ["--version"], { cwd: join(dir, "node_modules", ".bin"), encoding: "utf8" });
  console.log("no-shell version:", JSON.stringify(verNoShell.stdout.trim()), "status:", verNoShell.status);
} finally {
  await rm(dir, { recursive: true, force: true });
}
