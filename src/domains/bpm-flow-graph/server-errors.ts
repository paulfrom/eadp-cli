import { CliError, cliErrorDetails } from "../../errors.js";
import type { ResourceRecord } from "../../resource/core/client.js";

export interface ServerErrorLocation {
  nodeId?: string;
  nodeName?: string;
  edgeId?: string;
  jsonPath: string;
  expectedType: string;
  actualValue: unknown;
  fix: string;
  message: string;
}

/** Map designer save failures back to the exact canonical graph field. */
export function mapGraphServerError(
  error: unknown,
  change: { name: string; canonical: string }
): unknown {
  if (!(error instanceof CliError)) return error;
  const graph = parseRecord(change.canonical);
  if (!graph) return error;
  const serverText = `${error.message}\n${safeStringify(error.detail)}`;
  const locations: ServerErrorLocation[] = [];
  const process = isRecord(graph.process) ? graph.process : undefined;
  const nodes = process && isRecord(process.nodes) ? process.nodes : undefined;

  if (/autoExecuteUser|autoExecuteService/i.test(serverText) && nodes) {
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (!isRecord(node)) continue;
      const config = isRecord(node.nodeConfig) ? node.nodeConfig : undefined;
      const other = config && isRecord(config.otherParams) ? config.otherParams : undefined;
      if (!other || other.autoExecuteUser === undefined) continue;
      const jsonPath = `process.nodes.${nodeId}.nodeConfig.otherParams.autoExecuteUser`;
      locations.push(location({
        nodeId,
        node,
        jsonPath,
        expectedType: "object（自动执行人配置对象）",
        actualValue: other.autoExecuteUser,
        fix: "把 autoExecuteUser 改为对象，并在 autoExecuteServiceUrl 中填写已登记的接口 URL；不要传姓名字符串或环境内 ID"
      }));
    }
  }

  if (/notifySelfDefinition[\s\S]{0,120}type|type[\s\S]{0,120}notifySelfDefinition/i.test(serverText) && nodes) {
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (!isRecord(node)) continue;
      const config = isRecord(node.nodeConfig) ? node.nodeConfig : undefined;
      const notify = config && isRecord(config.notify) ? config.notify : undefined;
      const before = notify && isRecord(notify.before) ? notify.before : undefined;
      const self = before && isRecord(before.notifySelfDefinition)
        ? before.notifySelfDefinition
        : undefined;
      if (!self || self.type === undefined) continue;
      const jsonPath = `process.nodes.${nodeId}.nodeConfig.notify.before.notifySelfDefinition.type`;
      locations.push(location({
        nodeId,
        node,
        jsonPath,
        expectedType: "array<string>（通知方式字符串数组）",
        actualValue: self.type,
        fix: "把通知方式写成字符串数组，例如 [\"MESSAGE\"]；不要写逗号拼接字符串、对象或环境内通知 ID"
      }));
    }
  }

  if (/beforeStartServiceUrl|beforeStartServiceId/i.test(serverText) && process) {
    const jsonPath = "process.beforeStartServiceUrl";
    locations.push({
      jsonPath,
      expectedType: "string（流程提交前接口 URL 字符串）",
      actualValue: process.beforeStartServiceUrl,
      fix: "在规范化文件中把 beforeStartServiceUrl 设置为已登记 EVENT 接口的 URL 字符串；导入时由 CLI 映射目标 ID，不要直接填 beforeStartServiceId",
      message: `流程 ${change.name} 字段 ${jsonPath} 期望类型 string（接口 URL 字符串） 实际值 ${display(process.beforeStartServiceUrl)}；修复提示：填写已登记 EVENT 接口的 URL 字符串，不要直接填目标环境 ID`
    });
  }

  if (nodes && /duplicate[^\n]*(?:edge|id)|(?:edge|id)[^\n]*duplicate|重复[^\n]*(?:边|edge|id)|(?:边|edge|id)[^\n]*重复/i.test(serverText)) {
    const seen = new Map<string, { nodeId: string; node: ResourceRecord; path: string }>();
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (!isRecord(node) || !Array.isArray(node.target)) continue;
      for (const [index, target] of node.target.entries()) {
        if (!isRecord(target)) continue;
        const uel = isRecord(target.uel) ? target.uel : undefined;
        const edgeId = text(target.id) ?? text(target.edgeId) ?? text(uel?.id);
        if (!edgeId) continue;
        const jsonPath = `process.nodes.${nodeId}.target[${index}].id`;
        const current = { nodeId, node, path: jsonPath };
        const previous = seen.get(edgeId);
        if (previous) {
          for (const item of [previous, current]) {
            locations.push(location({
              nodeId: item.nodeId,
              node: item.node,
              edgeId,
              jsonPath: item.path,
              expectedType: "unique string（全图唯一边 ID）",
              actualValue: edgeId,
              fix: `边 ${edgeId} 与 ${previous.path} 重复；为每条边分配全图唯一 id，并先运行 bpm graph validate --strict`
            }));
          }
        } else {
          seen.set(edgeId, current);
        }
      }
    }
    // A server may reject a generated ID even when the canonical file omitted
    // explicit edge IDs. Preserve a precise edge location whenever its message
    // contains source/target information, otherwise do not invent a location.
    if (locations.length === 0) {
      const mentionedId = serverText.match(/(?:edge(?:\s+id)?|边(?:\s*id)?)\s*[:=#]?\s*["']?([A-Za-z0-9_.:-]+)/i)?.[1];
      if (mentionedId) {
        for (const [nodeId, node] of Object.entries(nodes)) {
          if (!isRecord(node) || !Array.isArray(node.target)) continue;
          for (const [index, target] of node.target.entries()) {
            if (!isRecord(target)) continue;
            const targetId = text(target.targetId);
            const generated = `${nodeId}->${targetId ?? "?"}[${index}]`;
            if (!serverText.includes(nodeId) && !serverText.includes(generated)) continue;
            const jsonPath = `process.nodes.${nodeId}.target[${index}]`;
            locations.push(location({
              nodeId,
              node,
              edgeId: generated,
              jsonPath,
              expectedType: "unique string（全图唯一边 ID）",
              actualValue: mentionedId,
              fix: "检查同一 source/target 之间是否重复连线；为每条边设置唯一 id，或删除重复边后重新校验"
            }));
          }
        }
      }
    }
  }

  if (locations.length === 0) return error;
  const details = cliErrorDetails(error);
  return new CliError(
    `服务端流程图校验失败：${error.message}\n${locations.map((item) => item.message).join("\n")}`,
    error.exitCode,
    {
      ...details,
      code: "GRAPH_SERVER_VALIDATION_FAILED",
      detail: {
        server: details.detail,
        locations
      }
    }
  );
}

function location(options: {
  nodeId: string;
  node: ResourceRecord;
  edgeId?: string;
  jsonPath: string;
  expectedType: string;
  actualValue: unknown;
  fix: string;
}): ServerErrorLocation {
  const nodeName = text(options.node.name) ?? options.nodeId;
  return {
    nodeId: options.nodeId,
    nodeName,
    ...(options.edgeId === undefined ? {} : { edgeId: options.edgeId }),
    jsonPath: options.jsonPath,
    expectedType: options.expectedType,
    actualValue: options.actualValue,
    fix: options.fix,
    message: `节点 ${nodeName}(${options.nodeId}) 字段 ${options.jsonPath} 期望类型 ${options.expectedType} 实际值 ${display(options.actualValue)}；修复提示：${options.fix}`
  };
}

function parseRecord(value: string): ResourceRecord | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function display(value: unknown): string {
  const rendered = value === undefined ? "<缺失>" : safeStringify(value);
  return rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
