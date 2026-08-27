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
  options: { aliases?: string[]; dependencies?: string[] } = {}
): string {
  return `schemaVersion: eadp.resource-contract.v1
id: ${id}
${options.aliases ? `aliases:\n${options.aliases.map((alias) => `  - ${alias}`).join("\n")}\n` : ""}${options.dependencies ? `dependencies:\n${options.dependencies.map((dependency) => `  - ${dependency}`).join("\n")}\n` : ""}title: external test
description: strict data-only resource contract
service: sei-basic
query:
  path: external/findAll
  method: GET
read: findAll
identityFields: []
compareFields: []
writableFields: []
tenant:
  policy: any
capabilities:
  - query
help: query only
`;
}
