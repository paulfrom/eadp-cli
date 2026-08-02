import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CliError } from "../errors.js";
import { endpointSchema, type EndpointDefinition } from "./schema.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultCatalogDirectory = join(packageRoot, "catalog");

export async function loadCatalog(
  directory = process.env.EADP_CATALOG_DIR ?? defaultCatalogDirectory
): Promise<EndpointDefinition[]> {
  const files = await collectYamlFiles(directory);
  const endpoints = (
    await Promise.all(
      files.map(async (file) => {
        const parsed = parse(await readFile(file, "utf8")) as unknown;
        const definitions = Array.isArray(parsed) ? parsed : [parsed];
        return definitions.map((definition) => endpointSchema.parse(definition));
      })
    )
  ).flat();
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) {
      throw new CliError(`接口 ID 重复：${endpoint.id}`);
    }
    ids.add(endpoint.id);
  }
  return endpoints.sort((left, right) => left.id.localeCompare(right.id));
}

async function collectYamlFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(path)));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

export async function findEndpoint(id: string): Promise<EndpointDefinition> {
  const endpoints = await loadCatalog();
  const endpoint = endpoints.find((candidate) => candidate.id === id);
  if (!endpoint) {
    throw new CliError(`接口不存在：${id}`);
  }
  return endpoint;
}
