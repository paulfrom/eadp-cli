/**
 * eadp-operator Skill contract-adaptation tests:
 * - generic guidance is discovered from live resource commands/contracts
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

const skillRoot = join(process.cwd(), "skills", "eadp-operator");

describe("eadp-operator Skill：契约自适应协议", () => {
  it("不维护普通资源白名单或静态时间能力，并保持一层 reference 引用", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    const genericReferences = await Promise.all([
      readFile(join(skillRoot, "references", "query-audit.md"), "utf8"),
      readFile(join(skillRoot, "references", "resource-sync.md"), "utf8")
    ]);
    const genericGuidance = [skill, ...genericReferences].join("\n").replace(/\s+/g, " ");
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
    expect(skill).toContain("eadp resource list");
    expect(skill).toContain("eadp resource describe <name>");
    expect(skill).toContain("eadp resource <query|write|compare|sync> <name> --help");
    for (const action of ["query", "write", "compare", "sync"]) {
      expect(skill).not.toContain(`eadp resource ${action} --help`);
    }
    expect(skill).toContain("capabilities");
    expect(skill).toContain("tenant.policy");
    expect(skill).toContain("identityFields");
    expect(skill).toContain("compareFields");
    expect(skill).toContain("writableFields");
    expect(skill).toContain("defaults.create");
    expect(skill).toContain("filtering.time");
    expect(skill).toContain("enums");
    expect(skill).toContain("selectors");
    expect(skill).toContain("adapter");
    expect(skill).toContain("handler");
    expect(skill).toContain("rollback");

    expect(skill).not.toMatch(/已注册(?:普通)?资源[：:][^\n]*(?:app-module|feature-group|serial-number)/);
    expect(skill).not.toMatch(/(?:app-module|feature-group|serial-number)[^\n]*(?:支持|不支持).*(?:时间|created-in|from|to)/i);
    expect(skill).not.toMatch(/eadp\s+(?:api|call|interface)\s+(?:list|catalog|describe)/i);
    expect(genericGuidance).not.toMatch(/app-module.*feature-group.*serial-number.*(?:declare|support|支持|不支持).*time/i);
    expect(resourceCommand).toContain("const registeredContracts = listResourceContracts();");
    expect(resourceCommand).not.toMatch(/(?:feature|menu|bpm|serial-number)\s*===\s*["']/i);

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
