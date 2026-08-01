import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageJsonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json"
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version?: unknown;
};

if (typeof packageJson.version !== "string") {
  throw new Error("package.json 缺少有效的 version");
}

export const cliVersion = packageJson.version;
