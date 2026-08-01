import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CliError } from "../errors.js";
import { configSchema, emptyConfig, type EadpConfig } from "./schema.js";

export class ConfigStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(directory = process.env.EADP_CONFIG_DIR ?? join(homedir(), ".eadp-cli")) {
    this.directory = directory;
    this.filePath = join(directory, "config.yaml");
  }

  async load(): Promise<EadpConfig> {
    try {
      const source = await readFile(this.filePath, "utf8");
      const migration = migrateLegacyConfig(parse(source));
      const config = configSchema.parse(migration.value);
      if (migration.changed) {
        await this.save(config);
      }
      return config;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return emptyConfig();
      }
      if (error instanceof Error && error.name === "ZodError") {
        throw new CliError(`配置文件格式无效：${error.message}`);
      }
      throw error;
    }
  }

  async save(config: EadpConfig): Promise<void> {
    const validated = configSchema.parse(config);
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.filePath, stringify(validated), {
      encoding: "utf8",
      mode: 0o600
    });
    if (process.platform !== "win32") {
      await chmod(this.filePath, 0o600);
    }
  }

  async update(mutator: (config: EadpConfig) => void): Promise<EadpConfig> {
    const config = await this.load();
    mutator(config);
    await this.save(config);
    return config;
  }
}

function migrateLegacyConfig(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value) || !isRecord(value.environments)) {
    return { value, changed: false };
  }

  let changed = false;
  const environments: Record<string, unknown> = {};
  for (const [environmentName, rawEnvironment] of Object.entries(value.environments)) {
    if (!isRecord(rawEnvironment) || !isRecord(rawEnvironment.accounts)) {
      environments[environmentName] = rawEnvironment;
      continue;
    }

    const accounts = Object.entries(rawEnvironment.accounts).filter((entry) =>
      isRecord(entry[1])
    ) as [string, Record<string, unknown>][];
    const preferredName =
      typeof rawEnvironment.defaultAccount === "string" &&
      accounts.some(([name]) => name === rawEnvironment.defaultAccount)
        ? rawEnvironment.defaultAccount
        : accounts[0]?.[0];

    if (!preferredName) {
      environments[environmentName] = rawEnvironment;
      continue;
    }

    changed = true;
    for (const [accountName, legacyAccount] of accounts) {
      const baseName =
        accountName === preferredName ? environmentName : `${environmentName}-${accountName}`;
      const migratedName = uniqueEnvironmentName(baseName, environments, value.environments);
      environments[migratedName] = {
        baseUrl: rawEnvironment.baseUrl,
        ...(typeof legacyAccount.token === "string"
          ? { token: legacyAccount.token }
          : { tokenEnv: legacyAccount.tokenEnv })
      };
    }
  }

  return {
    value: changed ? { ...value, environments } : value,
    changed
  };
}

function uniqueEnvironmentName(
  requestedName: string,
  migrated: Record<string, unknown>,
  original: Record<string, unknown>
): string {
  let candidate = requestedName;
  let suffix = 2;
  while (candidate in migrated || (candidate !== requestedName && candidate in original)) {
    candidate = `${requestedName}-${suffix++}`;
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
