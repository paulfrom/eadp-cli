/**
 * Keep the Skill protocol generic: a future ordinary ResourceContract must not
 * require a new resource-name branch or a documentation change.
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
    pageSize: 100,
    totalSemantics: "records"
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
  }
};

const futureHandlerResource: ResourceContract = {
  id: "future-handler-resource",
  title: "Future handler resource",
  description: "A special workflow extension used to cover handler/selectors.",
  service: "future-service",
  query: { path: "future-special/query", method: "GET" },
  read: "handler",
  identityFields: [],
  compareFields: [],
  writableFields: [],
  tenant: { policy: "any" },
  capabilities: ["query"],
  help: "Future handler resource help",
  handler: "future-handler",
  selectors: [{
    name: "scope",
    valuePlaceholder: "scope-code",
    description: "Scope selector",
    required: true
  }]
};

describe("eadp-operator Skill：普通资源契约自适应", () => {
  it("覆盖 future ResourceContract 的字段和动态发现协议", async () => {
    const skill = await readFile(skillPath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";
    const metadataKeys = frontmatter
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => line.slice(0, line.indexOf(":")))
      .filter(Boolean);
    expect(metadataKeys).toEqual(["name", "description"]);

    const registry = createResourceRegistry([futureResource, futureHandlerResource]);
    expect(registry.get("future-resource")).toMatchObject({
      id: "future-resource",
      service: "future-service"
    });

    const contractFields = new Set([
      ...Object.keys(futureResource),
      ...Object.keys(futureHandlerResource)
    ]);
    for (const field of contractFields) {
      expect(skill, "missing contract field: " + field).toContain(field);
    }

    for (const fact of [
      "tenant.policy",
      "tenant.bindField",
      "defaults.create",
      "preserveTargetFields",
      "preserveTargetFieldsWhenMissing",
      "filtering.time",
      "filtering.defaultTimeField",
      "total",
      "path",
      "method",
      "pageField",
      "pageNumberField",
      "pageSizeField",
      "startPage",
      "rowsField",
      "pageSize",
      "totalSemantics",
      "value",
      "meaning",
      "name",
      "valuePlaceholder",
      "description",
      "required",
      "resource",
      "remove",
      "lookup",
      "idField",
      "idPlacement"
    ]) {
      expect(skill, "missing contract fact: " + fact).toContain(fact);
    }

    expect(skill).toContain(
      "eadp resource <query|write|compare|sync> <name> --help"
    );
    for (const action of ["query", "write", "compare", "sync"]) {
      expect(skill).not.toContain("eadp resource " + action + " --help");
    }
    expect(skill).toContain("eadp resource list");
    expect(skill).toContain("eadp resource describe <name>");
    expect(skill).toContain("same command with " + tick + "--apply" + tick);
    expect(skill).toContain("read-only CLI queries");
    expect(skill).toContain("Do not");
    expect(skill).toContain("retry");
    expect(skill).toContain("verified: true");
    expect(skill).toContain("Load references only when needed");
    expect(skill).toContain("References add domain constraints only");

    const actionStart = skill.indexOf("## Drive actions from the selected contract");
    const workflowStart = skill.indexOf("## Run the common state machine");
    const actionProtocol = skill.slice(actionStart, workflowStart);
    const actionFields: Record<string, string[]> = {
      query: [
        "capabilities.query", "tenant", "query", "read", "pagination",
        "filtering", "enums", "selectors", "adapter", "handler"
      ],
      write: [
        "capabilities.write", "tenant", "save", "writableFields", "defaults",
        "enums", "adapter", "handler", "rollback"
      ],
      compare: [
        "capabilities.compare", "tenant", "query", "read", "pagination",
        "identityFields", "compareFields", "filtering", "enums", "selectors",
        "adapter", "handler"
      ],
      sync: [
        "capabilities.sync", "tenant", "identityFields", "compareFields",
        "writableFields", "defaults", "filtering", "enums", "selectors",
        "adapter", "handler", "rollback"
      ]
    };
    for (const [action, fields] of Object.entries(actionFields)) {
      const marker = "- " + tick + action + tick + ":";
      const start = actionProtocol.indexOf(marker);
      expect(start, "missing action protocol: " + action).toBeGreaterThanOrEqual(0);
      const next = actionProtocol.indexOf("\n- " + tick, start + marker.length);
      const block = actionProtocol.slice(start, next === -1 ? undefined : next);
      for (const field of fields) {
        expect(block, action + " missing " + field).toContain(field);
      }
    }

    expect(skill).not.toContain("future-resource");
    expect(skill).not.toMatch(/eadp\s+(?:api|call|catalog|interface)\b/i);
    expect(skill).not.toMatch(
      /(?:allowlist|whitelist|白名单|resource inventory|资源清单|time-support table)[^\n]{0,40}[:=]\s*[\[(]/i
    );
  });
});
