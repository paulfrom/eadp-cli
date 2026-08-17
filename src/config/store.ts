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
      return configSchema.parse(parse(source));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return emptyConfig();
      }
      if (error instanceof Error && error.name === "ZodError") {
        throw new CliError(`配置文件格式无效：${error.message}`, 1, { code: "CONFIG_INVALID" });
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
