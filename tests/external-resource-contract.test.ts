import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  runCommand,
  trackDirectory
} from "./helpers/index.js";

const exampleDirectory = resolve("skills/eadp-resource-contract/assets");
const exampleFile = join(exampleDirectory, "db-info.resource.yaml");

afterEach(async () => {
  await cleanupAll();
});

describe("declarative external resource contracts", () => {
  it("validates and discovers the mounted DbInfo contract without remote access", async () => {
    const fixture = await createFixture();
    await mountExampleContract(fixture.store.contractsDirectory);

    const validationPath = process.platform === "win32"
      ? exampleFile.replaceAll("\\", "/")
      : exampleFile;
    const validation = JSON.parse(await runCommand(fixture.program(), [
      "resource", "validate", validationPath
    ])) as { success: boolean; contracts: Array<{ id: string }> };
    expect(validation.success).toBe(true);
    expect(validation.contracts.map((contract) => contract.id)).toEqual(["db-info"]);
    expect(fixture.server("source").requests).toHaveLength(0);

    const catalog = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect"
    ])) as { resources: Array<{ name: string; sensitiveFields: string[] }> };
    expect(catalog.resources).toContainEqual(expect.objectContaining({
      name: "db-info",
      sensitiveFields: ["dbPass"]
    }));
    expect(fixture.server("source").requests).toHaveLength(0);
  });

  it("returns the fixed default generation target without reading environments", async () => {
    const fixture = await createFixture();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "contract-path", "content-template"
    ])) as {
      success: boolean;
      kind: string;
      resource: string;
      directory: string;
      path: string;
    };
    expect(output).toEqual({
      success: true,
      kind: "eadp.resource-contract-path.v1",
      resource: "content-template",
      directory: resolve(fixture.store.contractsDirectory),
      path: resolve(fixture.store.contractsDirectory, "content-template.resource.yaml")
    });
    expect(fixture.server("source").requests).toHaveLength(0);
  });

  it("executes a mounted query through the generic engine and always redacts dbPass", async () => {
    const fixture = await createFixture({
      defaultAuthorityPolicy: "NormalUser",
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "dev-token" }]
    });
    await mountExampleContract(fixture.store.contractsDirectory);
    await writeFile(
      join(fixture.store.contractsDirectory, "broken.resource.yaml"),
      "schemaVersion: wrong\nid: broken\n",
      "utf8"
    );
    fixture.server("dev").onEndsWith("/dbInfo/findByPage", (context) => {
      context.json(eadpPage([{
        id: "db-1",
        dbName: "reporting",
        dbType: "MYSQL",
        dbUser: "reader",
        dbPass: "must-not-leak"
      }], { records: 1, total: 1 }));
    });

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "db-info", "--env", "dev", "--fields", "dbName,dbPass"
    ])) as {
      items: Array<Record<string, unknown>>;
      contractIssues: Array<{ path: string; message: string }>;
    };
    expect(output.items).toEqual([{ dbName: "reporting", dbPass: "[REDACTED]" }]);
    expect(output.contractIssues).toEqual([
      expect.objectContaining({ path: expect.stringContaining("broken.resource.yaml") })
    ]);
    const request = fixture.server("dev").requests.find((item) =>
      item.path.endsWith("/dbInfo/findByPage")
    );
    expect(request).toMatchObject({ method: "POST" });
    expect(request?.body).toMatchObject({
      pageInfo: { page: 1, rows: 500 },
      filters: [],
      sortOrders: []
    });
  });

  it("discovers and reads one external resource detail through declared selectors", async () => {
    const fixture = await createFixture({
      defaultAuthorityPolicy: "NormalUser",
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "dev-token" }]
    });
    await mkdir(fixture.store.contractsDirectory, { recursive: true });
    await writeFile(
      join(fixture.store.contractsDirectory, "external-detail.resource.yaml"),
      validQueryContract("external-detail", { detail: true }),
      "utf8"
    );
    fixture.server("dev").onEndsWith("/external/findOne", (context) => {
      expect(context.query.get("id")).toBe("db-1");
      context.json({ id: "db-1", name: "reporting", secret: "must-not-leak" });
    });

    const action = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect", "external-detail", "detail"
    ])) as { requiredOptions: string[]; selectors: Record<string, unknown> };
    expect(action.requiredOptions).toContain("--select <name=value>");
    expect(action.selectors).toEqual({
      id: { required: true, valuePlaceholder: "id", description: "资源 ID" }
    });

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "detail", "external-detail", "--env", "dev", "--select", "id=db-1"
    ])) as { kind: string; selectors: Record<string, string>; item: Record<string, unknown> };
    expect(output).toMatchObject({
      kind: "eadp.resource.detail.v1",
      selectors: { id: "db-1" },
      item: { id: "db-1", name: "reporting", secret: "[REDACTED]" }
    });
  });

  it("detail 缺失、未知或重复 selector 时在远端请求前失败", async () => {
    const fixture = await createFixture({
      defaultAuthorityPolicy: "NormalUser",
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "dev-token" }]
    });
    await mkdir(fixture.store.contractsDirectory, { recursive: true });
    await writeFile(
      join(fixture.store.contractsDirectory, "external-detail.resource.yaml"),
      validQueryContract("external-detail", { detail: true }),
      "utf8"
    );

    const cases = [
      {
        args: ["resource", "detail", "external-detail", "--env", "dev"],
        code: "REQUIRED_SELECTOR_MISSING"
      },
      {
        args: ["resource", "detail", "external-detail", "--env", "dev", "--select", "unknown=db-1"],
        code: "UNKNOWN_SELECTOR"
      },
      {
        args: [
          "resource", "detail", "external-detail", "--env", "dev",
          "--select", "id=db-1", "--select", "id=db-2"
        ],
        code: "INVALID_ARGUMENT"
      }
    ] as const;
    for (const testCase of cases) {
      await expect(fixture.program().parseAsync([...testCase.args], { from: "user" }))
        .rejects.toMatchObject<Partial<CliError>>({ code: testCase.code });
      expect(fixture.server("dev").requests).toHaveLength(0);
    }
  });

  it("按契约组合映射 POST 明细的 path、query 与 body 选择器", async () => {
    const fixture = await createFixture({
      defaultAuthorityPolicy: "NormalUser",
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "dev-token" }]
    });
    await mkdir(fixture.store.contractsDirectory, { recursive: true });
    await writeFile(
      join(fixture.store.contractsDirectory, "composite-detail.resource.yaml"),
      validQueryContract("composite-detail", { detail: true, compositeDetail: true }),
      "utf8"
    );
    fixture.server("dev").onEndsWith("/external/db-1/findOne", (context) => {
      expect(context.method).toBe("POST");
      expect(context.query.get("scope")).toBe("tenant-a");
      expect(context.body).toEqual({ locale: "zh-CN" });
      context.json({ id: "db-1", name: "reporting" });
    });

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "detail", "composite-detail", "--env", "dev",
      "--select", "id=db-1", "--select", "scope=tenant-a", "--select", "locale=zh-CN"
    ])) as { item: Record<string, unknown> };
    expect(output.item).toMatchObject({ id: "db-1", name: "reporting" });
  });

  it("registers every usable contract and reports all file failures after the directory scan", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.store.contractsDirectory, { recursive: true });
    await writeFile(
      join(fixture.store.contractsDirectory, "a.resource.yaml"),
      "schemaVersion: wrong\nid: first-bad\n",
      "utf8"
    );
    await writeFile(
      join(fixture.store.contractsDirectory, "b.resource.yaml"),
      `${validQueryContract("second-bad")}\nhandler: executable-code\n`,
      "utf8"
    );
    await writeFile(
      join(fixture.store.contractsDirectory, "c.resource.yaml"),
      validQueryContract("valid-after-errors"),
      "utf8"
    );

    const catalog = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect"
    ])) as {
      resources: Array<{ name: string }>;
      contractIssues: Array<{ path: string; message: string }>;
    };
    expect(catalog.resources).toContainEqual(expect.objectContaining({ name: "valid-after-errors" }));
    expect(catalog.contractIssues).toEqual([
      expect.objectContaining({ path: expect.stringContaining("a.resource.yaml") }),
      expect.objectContaining({ path: expect.stringContaining("b.resource.yaml") })
    ]);
    await expect(fixture.program().parseAsync([
      "resource", "validate", fixture.store.contractsDirectory
    ], { from: "user" })).rejects.toMatchObject<Partial<CliError>>({
      code: "RESOURCE_CONTRACT_INVALID",
      issues: catalog.contractIssues
    });
    expect(fixture.server("source").requests).toHaveLength(0);
  });

  it("isolates conflicts, missing dependencies, cycles, and their dependents", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.store.contractsDirectory, { recursive: true });
    const manifests: Record<string, string> = {
      "a-conflict.resource.yaml": validQueryContract("conflict-a", { aliases: ["shared-name"] }),
      "b-conflict.resource.yaml": validQueryContract("conflict-b", { aliases: ["shared-name"] }),
      "c-missing.resource.yaml": validQueryContract("missing-dependency", { dependencies: ["absent"] }),
      "d-cycle.resource.yaml": validQueryContract("cycle-a", { dependencies: ["cycle-b"] }),
      "e-cycle.resource.yaml": validQueryContract("cycle-b", { dependencies: ["cycle-a"] }),
      "f-dependent.resource.yaml": validQueryContract("cycle-dependent", { dependencies: ["cycle-a"] }),
      "z-survivor.resource.yaml": validQueryContract("survivor")
    };
    await Promise.all(Object.entries(manifests).map(([name, source]) =>
      writeFile(join(fixture.store.contractsDirectory, name), source, "utf8")
    ));

    const catalog = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect"
    ])) as {
      resources: Array<{ name: string }>;
      contractIssues: Array<{ path: string; message: string }>;
    };
    const names = catalog.resources.map(({ name }) => name);
    expect(names).toContain("survivor");
    expect(names).not.toEqual(expect.arrayContaining([
      "conflict-a",
      "conflict-b",
      "missing-dependency",
      "cycle-a",
      "cycle-b",
      "cycle-dependent"
    ]));
    expect(catalog.contractIssues).toHaveLength(6);
    expect(catalog.contractIssues.map(({ path }) => path)).toEqual(expect.arrayContaining(
      Object.keys(manifests).filter((name) => name !== "z-survivor.resource.yaml")
        .map((name) => expect.stringContaining(name))
    ));

    await expect(fixture.program().parseAsync([
      "resource", "inspect", "cycle-a"
    ], { from: "user" })).rejects.toMatchObject<Partial<CliError>>({
      code: "UNKNOWN_RESOURCE",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("d-cycle.resource.yaml") })
      ])
    });
    expect(fixture.server("source").requests).toHaveLength(0);
  });

  it("rejects malformed, relative, and conflicting contracts before any remote request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eadp-contract-"));
    trackDirectory(directory);
    const duplicate = join(directory, "duplicate.resource.yaml");
    await writeFile(duplicate, validQueryContract("feature"), "utf8");
    const malformed = join(directory, "malformed.resource.yaml");
    await writeFile(malformed, `${validQueryContract("external-test")}\nadapter: executable-code\n`, "utf8");
    const fixture = await createFixture();

    await expect(fixture.program().parseAsync([
      "resource", "validate", duplicate
    ], { from: "user" })).rejects.toMatchObject<Partial<CliError>>({
      code: "RESOURCE_CONTRACT_CONFLICT"
    });
    await expect(fixture.program().parseAsync([
      "resource", "validate", malformed
    ], { from: "user" })).rejects.toMatchObject<Partial<CliError>>({
      code: "RESOURCE_CONTRACT_INVALID"
    });
    await expect(fixture.program().parseAsync([
      "resource", "validate", "examples/resource-contracts"
    ], { from: "user" })).rejects.toMatchObject<Partial<CliError>>({
      code: "RESOURCE_DIRECTORY_INVALID"
    });
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});

async function mountExampleContract(contractsDirectory: string): Promise<void> {
  await mkdir(contractsDirectory, { recursive: true });
  await copyFile(exampleFile, join(contractsDirectory, "db-info.resource.yaml"));
}

function validQueryContract(
  id: string,
  options: {
    aliases?: string[];
    dependencies?: string[];
    detail?: boolean;
    compositeDetail?: boolean;
  } = {}
): string {
  return `schemaVersion: eadp.resource-contract.v2
id: ${id}
${options.aliases ? `aliases:\n${options.aliases.map((alias) => `  - ${alias}`).join("\n")}\n` : ""}${options.dependencies ? `dependencies:\n${options.dependencies.map((dependency) => `  - ${dependency}`).join("\n")}\n` : ""}title: external test
description: strict data-only resource contract
service: sei-basic
query:
  path: external/findAll
  method: GET
${options.detail ? (options.compositeDetail ? `detail:
  path: external/{id}/findOne
  method: POST
  selectors:
    - name: id
      field: id
      placement: path
      valuePlaceholder: id
      description: 资源 ID
    - name: scope
      field: scope
      placement: query
      valuePlaceholder: tenant-code
      description: 租户范围
    - name: locale
      field: locale
      placement: body
      valuePlaceholder: locale
      description: 语言
` : `detail:
  path: external/findOne
  method: GET
  selectors:
    - name: id
      field: id
      placement: query
      valuePlaceholder: id
      description: 资源 ID
`) : ""}read: findAll
identityFields: []
compareFields: []
writableFields: []
${options.detail ? "sensitiveFields:\n  - secret\n" : ""}tenant:
  policy: any
capabilities:
  - query
${options.detail ? "  - detail\n" : ""}help: query only
`;
}
