import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { CliError, errorMessage } from "../../errors.js";
import {
  validateResourceContracts,
  type ResourceContract
} from "../core/contracts.js";
import { parseResourceContractManifest } from "./schema.js";

const CONTRACT_SUFFIX = ".resource.yaml";

export interface LoadedExternalResourceContract {
  path: string;
  contract: ResourceContract;
}

export interface ResourceContractScanResult {
  contracts: LoadedExternalResourceContract[];
  issues: Array<{ path: string; message: string }>;
}

export async function loadResourceContractPath(path: string): Promise<ResourceContract[]> {
  const result = await scanResourceContractPath(path);
  if (result.issues.length > 0) {
    throw new CliError(
      `资源契约扫描完成，${result.issues.length} 个文件失败：${path}`,
      1,
      {
        code: "RESOURCE_CONTRACT_INVALID",
        requiredInput: "resourceContract",
        issues: result.issues
      }
    );
  }
  return result.contracts.map(({ contract }) => contract);
}

/** Scan every manifest and retain all individually usable contracts. */
export async function scanResourceContractPath(path: string): Promise<ResourceContractScanResult> {
  assertAbsolutePath(path);
  const normalizedPath = resolve(path);
  let resolved: string;
  try {
    resolved = await realpath(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`资源契约路径不存在：${path}`, 1, {
        code: "RESOURCE_DIRECTORY_MISSING",
        requiredInput: "resourceContractPath"
      });
    }
    throw new CliError(`无法读取资源契约路径：${path}；${errorMessage(error)}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new CliError(`无法读取资源契约路径：${path}；${errorMessage(error)}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
  if (info.isFile()) return loadResourceContractFiles([resolved]);
  if (!info.isDirectory()) {
    throw new CliError(`资源契约路径不是文件或目录：${path}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
  let directoryEntries;
  try {
    directoryEntries = await readdir(resolved, { withFileTypes: true });
  } catch (error) {
    throw new CliError(`无法读取资源契约目录：${path}；${errorMessage(error)}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
  const entries = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(CONTRACT_SUFFIX))
    .sort((left, right) => left.name.localeCompare(right.name));
  return loadResourceContractFiles(entries.map((entry) => join(resolved, entry.name)));
}

export async function scanExternalResourceContracts(
  directory: string,
  options: { allowMissingDirectory?: boolean } = {}
): Promise<ResourceContractScanResult> {
  try {
    return await scanResourceContractPath(directory);
  } catch (error) {
    if (options.allowMissingDirectory === true &&
        error instanceof CliError && error.code === "RESOURCE_DIRECTORY_MISSING") {
      return { contracts: [], issues: [] };
    }
    throw error;
  }
}

async function loadResourceContractFiles(
  filePaths: readonly string[]
): Promise<ResourceContractScanResult> {
  const results = await Promise.all(filePaths.map(async (filePath) => {
    try {
      return { loaded: { path: filePath, contract: await loadResourceContractFile(filePath) } };
    } catch (error) {
      return {
        issues: error instanceof CliError && error.issues
          ? error.issues
          : [{ path: filePath, message: errorMessage(error) }]
      };
    }
  }));
  return {
    contracts: results.flatMap((result) => result.loaded ? [result.loaded] : []),
    issues: results.flatMap((result) => result.issues ?? [])
  };
}

async function loadResourceContractFile(filePath: string): Promise<ResourceContract> {
  if (!filePath.endsWith(CONTRACT_SUFFIX)) {
    throw new CliError(`资源契约文件必须以 ${CONTRACT_SUFFIX} 结尾：${filePath}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
  try {
    const source = await readFile(filePath, "utf8");
    const contract = parseResourceContractManifest(parse(source));
    return validateResourceContracts([contract])[0]!;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const detail = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")
      : errorMessage(error);
    throw new CliError(`资源契约无效：${filePath}；${detail}`, 1, {
      code: "RESOURCE_CONTRACT_INVALID",
      requiredInput: "resourceContract",
      issues: [{ path: filePath, message: detail }]
    });
  }
}

function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new CliError(`资源契约路径必须是绝对路径：${path}`, 1, {
      code: "RESOURCE_DIRECTORY_INVALID",
      requiredInput: "resourceContractPath"
    });
  }
}
