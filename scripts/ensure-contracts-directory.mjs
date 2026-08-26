import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configDirectory = resolve(
  process.env.EADP_CONFIG_DIR || join(homedir(), ".eadp-cli")
);

await mkdir(join(configDirectory, "contracts"), { recursive: true });
