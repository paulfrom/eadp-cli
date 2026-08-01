import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "node:path";
import { CliError } from "../errors.js";
import type {
  BpmBusinessModuleDefinition,
  BpmFlowDefinition,
  BpmProjectDefinition
} from "./schema.js";

const REGISTRY_CANDIDATES = [
  join("docs", "contracts", "BPM流程配置登记册.md"),
  join("docs", "BPM流程配置登记册.md"),
  "BPM流程配置登记册.md"
];

export async function discoverBpmProject(projectInput: string): Promise<BpmProjectDefinition> {
  const projectPath = resolve(projectInput);
  await ensureDirectory(projectPath);
  const registry = await findReadableFile(
    REGISTRY_CANDIDATES.map((candidate) => join(projectPath, candidate))
  );
  if (!registry) {
    throw new CliError(
      [
        "未发现 BPM 配置登记册。",
        `已检查：${REGISTRY_CANDIDATES.join("、")}`,
        "真实项目无需 YAML；请提供现有 BPM 登记册，或在登记册缺失时明确业务流程名称。"
      ].join("\n")
    );
  }

  const markdown = await readFile(registry, "utf8");
  const moduleCode = await discoverModuleCode(projectPath);
  const webBaseAddress = await discoverWebBaseAddress(projectPath);
  const moduleName =
    matchTableValue(markdown, "关联业务模块") ?? moduleCode;
  const flows = parseRegistryFlows(markdown);
  if (flows.length === 0) {
    throw new CliError(`BPM 登记册中没有可解析的流程：${registry}`);
  }

  const businessModule: BpmBusinessModuleDefinition = {
    code: moduleCode,
    name: moduleName,
    serviceName: moduleCode,
    ...(webBaseAddress ? { webBaseAddress } : {})
  };
  return { projectPath, sourcePath: registry, businessModule, flows };
}

export function selectBpmFlow(
  definition: BpmProjectDefinition,
  selector: string
): BpmFlowDefinition {
  const normalized = selector.trim().toLowerCase();
  const matches = definition.flows.filter(
    (flow) =>
      flow.code.toLowerCase() === normalized ||
      flow.name.toLowerCase() === normalized ||
      flow.entity.code.toLowerCase() === normalized
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new CliError(`流程选择不唯一：${selector}`);
  }
  throw new CliError(
    `未找到流程：${selector}。可选值：${definition.flows
      .map((flow) => `${flow.name}(${flow.code})`)
      .join("、")}`
  );
}

function parseRegistryFlows(markdown: string): BpmFlowDefinition[] {
  const headings = [...markdown.matchAll(/^##\s+(?:\d+\.\s*)?(.+?)\s*$/gm)];
  const flows: BpmFlowDefinition[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const name = heading[1]!.trim();
    if (name.includes("目录") || name.includes("模板")) {
      continue;
    }
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    const code = section.match(/\*\*流程模型\*\*[：:]\s*`([^`]+)`/)?.[1]?.trim();
    if (!code) {
      continue;
    }
    const entityRows = parseMarkdownTable(section, "业务实体");
    const entity = entityRows[0];
    if (!entity || entity.length < 4) {
      throw new CliError(`流程 ${name} 缺少业务实体配置`);
    }
    const interfaceRows = parseMarkdownTable(section, "集成接口");
    const pageRows = parseMarkdownTable(section, "工作页面");
    flows.push({
      name,
      code,
      entity: {
        name: entity[0]!,
        code: entity[1]!,
        serviceName: entity[2]!,
        ...(entity[3] ? { pcLookUrl: cleanCell(entity[3]) } : {})
      },
      interfaces: interfaceRows.map((row) => ({
        name: row[0]!,
        url: row[1]!,
        interfaceType: "EVENT"
      })),
      pages: pageRows.map((row) => ({
        name: row[0]!,
        pcUrl: cleanCell(row[1]!)
      }))
    });
  }
  return flows;
}

function parseMarkdownTable(section: string, title: string): string[][] {
  const heading = new RegExp(`^###\\s+${escapeRegExp(title)}\\s*$`, "m").exec(section);
  if (!heading) {
    return [];
  }
  const start = (heading.index ?? 0) + heading[0].length;
  const remaining = section.slice(start);
  const endMatch = /^###\s+|^---\s*$/m.exec(remaining);
  const tableSection = remaining.slice(0, endMatch?.index ?? remaining.length);
  return tableSection
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map(splitTableRow)
    .filter(
      (row, index) =>
        index >= 2 &&
        row.length > 0 &&
        row.some((cell) => cell.length > 0) &&
        !row.every((cell) => /^-+$/.test(cell))
    );
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cleanCell);
}

function cleanCell(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/（[^）]*）\s*$/, "")
    .trim();
}

async function discoverModuleCode(projectPath: string): Promise<string> {
  const settings = await findReadableFile([
    join(projectPath, "backend", "settings.gradle"),
    join(projectPath, "settings.gradle"),
    join(projectPath, "settings.gradle.kts")
  ]);
  if (settings) {
    const source = await readFile(settings, "utf8");
    const match = source.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return basename(projectPath);
}

async function discoverWebBaseAddress(projectPath: string): Promise<string | undefined> {
  const packageFile = await findReadableFile([
    join(projectPath, "frontend", "package.json"),
    join(projectPath, "package.json")
  ]);
  if (!packageFile) {
    return undefined;
  }
  try {
    const value = JSON.parse(await readFile(packageFile, "utf8")) as { name?: unknown };
    return typeof value.name === "string" ? value.name : undefined;
  } catch {
    return undefined;
  }
}

function matchTableValue(markdown: string, key: string): string | undefined {
  const pattern = new RegExp(
    `^\\|\\s*${escapeRegExp(key)}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*$`,
    "m"
  );
  return pattern.exec(markdown)?.[1]?.trim();
}

async function findReadableFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // 继续检查下一个真实项目约定路径。
    }
  }
  return undefined;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new CliError(`项目路径不是目录：${path}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`项目路径不存在或不可读取：${path}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
