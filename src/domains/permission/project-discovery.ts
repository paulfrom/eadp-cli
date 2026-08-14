import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CliError } from "../../errors.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".gradle",
  "build",
  "dist",
  "node_modules",
  "target",
  "coverage"
]);
const MAX_SOURCE_FILES = 2_000;

/**
 * Infer a short business-facing module name from a project directory.
 *
 * Existing project metadata is preferred (Gradle rootProject.name or the
 * package name).  When metadata is unavailable, a business description in a
 * source comment/annotation is considered before the directory basename.
 * The returned value is deliberately capped at eight Unicode code points so
 * it satisfies the AppModuleDto contract without inventing a meaningless
 * placeholder.
 */
export async function inferProjectModuleName(
  projectInput = process.cwd()
): Promise<{ name: string; projectPath: string; source: "metadata" | "comment" | "directory" }> {
  const projectPath = resolve(projectInput);
  await ensureDirectory(projectPath);

  const metadata = await readMetadataName(projectPath);
  if (metadata) {
    return { name: shortName(metadata), projectPath, source: "metadata" };
  }

  const comment = await discoverCommentName(projectPath);
  if (comment) {
    return { name: shortName(comment), projectPath, source: "comment" };
  }

  const directory = meaningfulName(basename(projectPath));
  if (directory) {
    return { name: shortName(directory), projectPath, source: "directory" };
  }

  throw new CliError(
    `无法从项目路径 ${projectPath} 推断有效应用模块名称；请提供包含项目名称或业务代码注释的项目路径`
  );
}

async function readMetadataName(projectPath: string): Promise<string | undefined> {
  const settingsCandidates = [
    join(projectPath, "backend", "settings.gradle"),
    join(projectPath, "settings.gradle"),
    join(projectPath, "settings.gradle.kts")
  ];
  for (const path of settingsCandidates) {
    const source = await readText(path);
    const match = source?.match(/rootProject\.name\s*=\s*[\"']([^\"']+)[\"']/);
    const value = match?.[1] ? meaningfulName(match[1]) : undefined;
    if (value) return value;
  }

  const packageSource = await readText(join(projectPath, "package.json"));
  if (packageSource) {
    try {
      const packageJson = JSON.parse(packageSource) as { name?: unknown };
      if (typeof packageJson.name === "string") {
        const packageName = packageJson.name.replace(/^@[^/]+\//, "");
        const value = meaningfulName(packageName);
        if (value) return value;
      }
    } catch {
      // An invalid package file is not a reason to guess a module name.
    }
  }
  return undefined;
}

async function discoverCommentName(projectPath: string): Promise<string | undefined> {
  const files = await collectSourceFiles(projectPath, { remaining: MAX_SOURCE_FILES });
  for (const path of files) {
    const source = await readText(path);
    if (!source) continue;
    const candidates = [
      source.match(/(?:项目名称|项目名|系统名称|业务名称)\s*[:：]\s*([^\r\n*<]{1,40})/u)?.[1],
      source.match(/实现功能\s*[:：]\s*([^\r\n*<]{1,40})/u)?.[1],
      source.match(/@Tag\s*\([^)]*description\s*=\s*["']([^"']+)["']/u)?.[1]
    ];
    for (const candidate of candidates) {
      const value = meaningfulName(candidate?.replace(/(?:服务|接口|API)$/u, ""));
      if (value) return value;
    }
  }
  return undefined;
}

async function collectSourceFiles(
  directory: string,
  budget: { remaining: number }
): Promise<string[]> {
  if (budget.remaining <= 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectSourceFiles(path, budget));
    } else if (
      entry.isFile() &&
      /\.(?:java|kt|ts|tsx|js|jsx|md)$/u.test(entry.name)
    ) {
      result.push(path);
      budget.remaining -= 1;
    }
    if (budget.remaining <= 0) break;
  }
  return result;
}

function meaningfulName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .replace(/^["'`]+|["'`,.;:，。；：]+$/gu, "")
    .replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  const token = normalized.toLocaleLowerCase();
  if (["project", "app", "application", "module", "service", "backend", "frontend", "src", "test"].includes(token)) {
    return undefined;
  }
  if (!/[\p{L}\p{N}]/u.test(normalized)) return undefined;
  return normalized;
}

function shortName(value: string): string {
  const short = [...value].slice(0, 8).join("").trim();
  if (!short || !/[\p{L}\p{N}]/u.test(short)) {
    throw new CliError(`推断出的应用模块名称无效：${value}`);
  }
  return short;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new CliError(`项目路径不是目录：${path}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`项目路径不存在或不可读取：${path}`);
  }
}
