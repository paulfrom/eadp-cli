/**
 * Keep the Skill protocol generic: a future ordinary ResourceContract must not
 * require a new resource-name branch, a documentation change, or a Skill
 * rewrite. The Skill routes intents and sequences commands; the CLI owns
 * contract internals, so the Skill must not copy transport/pagination detail.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createResourceRegistry,
  type ResourceContract
} from "../src/resource/core/contracts.js";

const skillPath = join(process.cwd(), "skills", "eadp-operator", "SKILL.md");
const tick = String.fromCharCode(96);

const futureResource: ResourceContract = {
  id: "future-resource",
  title: "Future resource",
  description: "A future ordinary resource used only by this protocol test.",
  service: "future-service",
  query: { path: "future/find", method: "POST" },
  save: { path: "future/save", method: "POST" },
  read: "paged",
  pagination: {
    pageField: "pageInfo",
    pageNumberField: "page",
    pageSizeField: "size",
    startPage: 1,
    rowsField: "rows",
    pageSize: 500,
    totalSemantics: "pages"
  },
  identityFields: ["tenantCode", "code"],
  compareFields: ["tenantCode", "code", "name", "state"],
  writableFields: ["tenantCode", "code", "name", "state"],
  tenant: { policy: "non-global", bindField: "tenantCode" },
  capabilities: ["query", "write", "compare", "sync"],
  help: "Future resource help",
  defaults: {
    create: { state: "NEW" },
    preserveTargetFields: ["createdAt"],
    preserveTargetFieldsWhenMissing: ["description"]
  },
  filtering: { time: true, defaultTimeField: "createdAt" },
  enums: {
    state: [
      { value: "NEW", meaning: "New" },
      { value: "READY", meaning: "Ready" }
    ]
  },
  adapter: "future-adapter",
  rollback: {
    service: "future-service",
    resource: "future-resource",
    remove: {
      path: "future/delete/{id}",
      method: "DELETE",
      idField: "id",
      idPlacement: "path"
    },
    lookup: {
      path: "future/findOne",
      method: "GET",
      idField: "id",
      idPlacement: "query"
    }
  },
  deletion: {
    service: "future-service",
    resource: "future-resource",
    remove: {
      path: "future/delete/{id}",
      method: "DELETE",
      idField: "id",
      idPlacement: "path"
    },
    lookup: {
      path: "future/findOne",
      method: "GET",
      idField: "id",
      idPlacement: "query"
    },
    restore: {
      path: "future/save",
      method: "POST"
    }
  }
};

describe("eadp-operator Skill：普通资源契约自适应", () => {
  it("覆盖 future ResourceContract 而不在 Skill 中复制契约内部细节", async () => {
    const skill = await readFile(skillPath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";
    const metadataKeys = frontmatter
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => line.slice(0, line.indexOf(":")))
      .filter(Boolean);
    expect(metadataKeys).toEqual(["name", "description"]);

    // A future contract registers through the generic engine without a Skill change.
    const registry = createResourceRegistry([futureResource]);
    expect(registry.get("future-resource")).toMatchObject({
      id: "future-resource",
      service: "future-service"
    });

    // 执行原则与动作序列在 Skill 中；契约内部字段由 CLI 引擎负责，不复制进 Skill。
    for (const fact of [
      "eadp resource inspect",
      "Execute directly when the request is complete",
      "Inspect when parameters are missing or ambiguous",
      "preview",
      "same command with " + tick + "--apply" + tick,
      "verified: true",
      "Stop on failure",
      "Do not",
      "retry",
      "Load references only when needed",
      "References add domain constraints only"
    ]) {
      expect(skill, "missing fact: " + fact).toContain(fact);
    }

    // 统一选择器语法：不出现逐资源专属选项，也不复制契约传输/分页字段。
    expect(skill).toContain("--select <name>=<value>");
    expect(skill).not.toContain("--flow <");
    expect(skill).not.toContain("--code <");
    expect(skill).not.toMatch(/pageField|pageNumberField|pageSizeField|totalSemantics|rowsField/i);
    expect(skill).not.toMatch(/findByPage|getMenuTree|api-gateway/i);

    expect(skill).not.toContain("future-resource");
    expect(skill).not.toMatch(/eadp\s+(?:api|call|catalog|interface)\b/i);
    expect(skill).not.toMatch(
      /(?:allowlist|whitelist|白名单|resource inventory|资源清单|time-support table)[^\n]{0,40}[:=]\s*[\[(]/i
    );
  });
});
