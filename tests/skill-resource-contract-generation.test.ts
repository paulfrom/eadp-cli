import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseResourceContractManifest } from "../src/resource/external/schema.js";

const skillRoot = join(process.cwd(), "skills", "eadp-resource-contract");

describe("eadp-resource-contract Skill", () => {
  it("作为独立 Skill 路由到 schema 与 DbInfo 证据示例", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("name: eadp-resource-contract");
    expect(skill).toContain("references/resource-contract-schema.md");
    expect(skill).toContain("references/db-info-example.md");
    expect(skill).toContain("eadp resource validate <absolute-file-or-directory>");
    expect(skill).toContain("never executes resource operations");
  });

  it("DbInfo 示例是可校验的 query-only 契约并保护 dbPass", async () => {
    const source = await readFile(
      join(skillRoot, "assets", "db-info.resource.yaml"),
      "utf8"
    );
    const contract = parseResourceContractManifest(parse(source));
    expect(contract).toMatchObject({
      id: "db-info",
      service: "sei-eai",
      query: { path: "dbInfo/findByPage", method: "POST" },
      read: "paged",
      pagination: {
        pageField: "pageInfo",
        pageNumberField: "page",
        pageSizeField: "rows",
        startPage: 1,
        rowsField: "rows",
        pageSize: 500,
        totalSemantics: "pages"
      },
      identityFields: [],
      compareFields: [],
      writableFields: [],
      sensitiveFields: ["dbPass"],
      tenant: { policy: "any" },
      capabilities: ["query"],
      filtering: { time: false }
    });
    expect(contract.save).toBeUndefined();
    expect(contract.rollback).toBeUndefined();
    expect(contract.enums?.dbType?.map((item) => item.value)).toEqual([
      "MYSQL",
      "POSTGRESQL",
      "SQLITE",
      "MS_SQL",
      "CH_DB",
      "ORACLE"
    ]);
  });
});
