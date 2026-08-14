import { CliError } from "../../errors.js";

export const BPM_NAME_MAX_LENGTH = 15;

export function bpmNameLengthError(resource: string, value: string): string | undefined {
  const length = Array.from(value).length;
  return length > BPM_NAME_MAX_LENGTH
    ? `BPM ${resource}名称超过 ${BPM_NAME_MAX_LENGTH} 个 Unicode 字符（实际 ${length}）：${value}`
    : undefined;
}

export function assertBpmNameLength(resource: string, value: string): void {
  const message = bpmNameLengthError(resource, value);
  if (message) throw new CliError(message);
}
