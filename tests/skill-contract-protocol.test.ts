/**
 * EADP documentation and Skill contract-adaptation tests:
 * - architecture and routing are explained before resource details
 * - the Skill routes intents and sequences commands; the CLI owns contract internals
 * - references stay one level below SKILL.md
 * - a newly registered virtual contract uses the generic preview/apply/verify protocol
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResourceEngine } from "../src/resource/core/engine.js";
import {
  createResourceRegistry,
  type ResourceContract
} from "../src/resource/core/contracts.js";
import type { ResourceClient } from "../src/resource/core/client.js";
import {
  listResourceContracts,
  specialResourceHandlerRegistry
} from "../src/resource/catalog.js";

const skillRoot = join(process.cwd(), "skills", "eadp-operator");

describe("eadp-operator Skill：契约自适应协议", () => {
  it("Skill 先讲架构与执行原则，资源与领域命令以名称清单呈现，不复制契约内部细节", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const resourceCommand = await readFile(
      join(process.cwd(), "src", "commands", "resource.ts"),
      "utf8"
    );
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";
    const metadataKeys = frontmatter
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => line.slice(0, line.indexOf(":")))
      .filter(Boolean);

    expect(metadataKeys).toEqual(["name", "description"]);
    expect(skill).toContain("eadp resource inspect");
    expect(skill).toContain("Execute directly when the request is complete");
    expect(skill).toContain("--select <name>=<value>");
    expect(skill).toContain("verified: true");
    expect(skill).toContain("Stop on failure");
    expect(skill).toContain("each environment's recorded `tenantCode`");
    expect(readme).toContain("每个环境已记录的 `tenantCode`");
    expect(skill).toContain('`tenant.policy: "any"` defaults to non-global for reads');
    expect(readme).toContain('`tenant.policy: "any"`）时默认按 non-global 校验');
    const directExecution = sectionBetween(
      skill,
      "## Execute directly when the request is complete",
      "## Inspect when parameters are missing or ambiguous"
    );
    expect(directExecution).not.toMatch(/^eadp resource .*--apply\s*$/m);

    // 架构先于资源清单，资源清单先于领域命令
    expectSectionOrder(skill, [
      "## Architecture and routing",
      "## Current registered resources",
      "## Special domain commands"
    ]);

    const skillResources = sectionBetween(
      skill,
      "## Current registered resources",
      "## Special domain commands"
    );
    const skillSpecial = sectionBetween(
      skill,
      "## Special domain commands",
      "## Write protocol (preview, authorize, apply, verify)"
    );

    // 资源清单覆盖全部注册资源与别名（一行名称，不含契约内部细节）
    const registeredResources = listResourceContracts().map((contract) => contract.id);
    for (const resource of registeredResources) {
      expect(skillResources, resource).toContain(`\`${resource}\``);
    }
    expect(skillResources).toContain("`user`");
    expect(skillResources).toContain("eadp resource inspect");
    expect(skillResources).not.toMatch(/pageField|rowsField|totalSemantics|findByPage/i);

    // 领域命令只列命令路由，不复制资源契约或字段级规则
    for (const command of [
      "permission apply feature",
      "permission apply feature-group",
      "menu create",
      "bpm inspect",
      "bpm configure",
      "rollback <operation-id"
    ]) {
      expect(skillSpecial, command).toContain(command);
    }

    // Skill 不复制 CLI 引擎已负责的传输/分页/端点细节，也不引入旧命令或逐资源分支
    expect(skill).not.toMatch(/pageInfo|totalSemantics|rowsField|pageSize\s*:|findByPage/i);
    expect(skill).not.toMatch(/api-gateway/i);
    expect(skill).not.toMatch(/eadp\s+(?:api|call|interface)\s+(?:list|catalog|describe)/i);
    expect(skill).not.toMatch(/eadp\s+(?:query|inspect|call)\s+<name>/i);
    expect(resourceCommand).toContain("listResourceContracts()");
    expect(resourceCommand).not.toMatch(/(?:feature|menu|bpm|serial-number)\s*===\s*["']/i);

    // 参考文档保持一层目录深度，不嵌套引用
    const references = [
      "bpm-configuration.md",
      "permission-management.md",
      "query-audit.md",
      "resource-sync.md",
      "rollback.md",
      "serial-number-sync.md",
      "write-contracts.md"
    ];
    for (const reference of references) {
      const content = await readFile(join(skillRoot, "references", reference), "utf8");
      expect(content, reference).not.toMatch(/\]\(references\//);
    }
    for (const reference of [
      "bpm-configuration.md",
      "query-audit.md",
      "resource-sync.md",
      "serial-number-sync.md",
      "write-contracts.md"
    ]) {
      const content = await readFile(join(skillRoot, "references", reference), "utf8");
      expect(content, reference).toMatch(/missing|ambiguous|缺失|歧义/);
      expect(content, reference).not.toMatch(
        /(?:Before planning, run|always run|始终先运行)[^\n]*resource inspect/i
      );
    }
    const queryReference = await readFile(join(skillRoot, "references", "query-audit.md"), "utf8");
    const syncReference = await readFile(join(skillRoot, "references", "resource-sync.md"), "utf8");
    expect(queryReference).toContain('`tenant.policy: "any"` defaults to');
    expect(syncReference).toContain('`tenant.policy:');
    expect(syncReference).toContain('"any"` defaults to non-global for compare/sync');

    // README 章节顺序保持架构 → 命令 → 资源 → 领域命令
    expectSectionOrder(readme, [
      "## 架构",
      "## 统一资源框架命令",
      "## 当前注册资源",
      "## 特殊领域命令"
    ]);
  });

  it("虚拟新注册资源无需静态分支即可完成 compare/sync preview、apply、verify 与幂等", async () => {
    const contract: ResourceContract = {
      id: "virtual-new-resource",
      title: "Virtual new resource",
      description: "A test-only resource proving the generic contract protocol.",
      service: "virtual-service",
      query: { path: "virtual/findAll", method: "GET" },
      save: { path: "virtual/save", method: "POST" },
      read: "findAll",
      identityFields: ["code"],
      compareFields: ["code", "name", "state"],
      writableFields: ["code", "name", "state"],
      tenant: { policy: "any" },
      capabilities: ["query", "write", "compare", "sync"],
      defaults: { create: { state: "NEW" } },
      filtering: { time: false },
      help: "Virtual resource help",
      rollback: {
        service: "virtual-service",
        resource: "virtual",
        remove: { path: "virtual/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
        lookup: { path: "virtual/findOne", method: "GET", idField: "id", idPlacement: "query" }
      }
    };
    const registry = createResourceRegistry([contract]);
    expect(registry.get("virtual-new-resource")).toMatchObject({ id: "virtual-new-resource" });

    const targetRows: Array<Record<string, unknown>> = [];
    const savedPayloads: Array<Record<string, unknown>> = [];
    const sourceClient = {
      queryContract: async () => [{ code: "V-1", name: "Virtual" }]
    } as unknown as ResourceClient;
    const targetClient = {
      queryContract: async () => targetRows.map((row) => ({ ...row })),
      saveContract: async (_selected: ResourceContract, payload: Record<string, unknown>) => {
        const saved = { ...payload, id: `virtual-${savedPayloads.length + 1}` };
        savedPayloads.push({ ...payload });
        targetRows.splice(0, targetRows.length, saved);
        return saved;
      }
    } as unknown as ResourceClient;

    const engine = new ResourceEngine();
    const preview = await engine.sync(
      contract,
      sourceClient,
      targetClient,
      { source: "source", target: "target" },
      { apply: false }
    );
    expect(preview).toMatchObject({
      applied: false,
      verified: true,
      summary: { create: 1, update: 0, unchanged: 0, blocked: 0 },
      changes: [{ action: "create", desired: { code: "V-1", name: "Virtual", state: "NEW" } }]
    });
    expect(savedPayloads).toHaveLength(0);

    const applied = await engine.sync(
      contract,
      sourceClient,
      targetClient,
      { source: "source", target: "target" },
      { apply: true }
    );
    expect(applied).toMatchObject({ applied: true, verified: true, summary: { create: 1 } });
    expect(savedPayloads).toEqual([{ code: "V-1", name: "Virtual", state: "NEW" }]);

    const unchanged = await engine.sync(
      contract,
      sourceClient,
      targetClient,
      { source: "source", target: "target" },
      { apply: true }
    );
    expect(unchanged).toMatchObject({ applied: false, verified: true, summary: { unchanged: 1 } });
    expect(savedPayloads).toHaveLength(1);
  });
});

function expectSectionOrder(document: string, headings: string[]): void {
  let previous = -1;
  for (const heading of headings) {
    const index = document.indexOf(heading);
    expect(index, `missing heading: ${heading}`).toBeGreaterThan(previous);
    previous = index;
  }
}

function sectionBetween(document: string, startHeading: string, endHeading: string): string {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);
  expect(start, `missing heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing heading: ${endHeading}`).toBeGreaterThan(start);
  return document.slice(start, end);
}
