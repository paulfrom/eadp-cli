import type { ResolvedEnvironment } from "../../config/resolve.js";
import { CliError } from "../../errors.js";
import { sendRequest } from "../../http/client.js";
import { isRecord, type ResourceRecord } from "../../resource/core/client.js";

const graphContract = {
  nodeType: "type",
  nodeConfig: "properties.nodeConfig",
  edgeSource: "sourceNodeId",
  edgeTarget: "targetNodeId",
  commonNodeConfig: ["name", "contextCode", "useContextCode", "failParams", "aviatorFailExp"]
};

const secretFields = new Set(["httploginpassword", "password", "dbpass"]);

export async function inspectTransNodes(options: {
  environment: ResolvedEnvironment;
  nodeName?: string | undefined;
  timeoutMs: number;
}): Promise<unknown> {
  const { environment, nodeName, timeoutMs } = options;
  const response = await sendRequest({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    method: "GET",
    path: "/api-gateway/sei-eai/nodeDesc/getAllNodeDesc",
    timeoutMs
  });
  const nodes = parseNodes(response.data);
  if (nodeName === undefined) {
    return {
      kind: "eadp.trans.node-catalog.v1",
      resource: "trans",
      environment: environment.name,
      graphContract,
      nodes: nodes.map((node) => ({ name: node.name, nodeName: node.nodeName }))
    };
  }
  const selected = nodes.find((node) => node.name === nodeName);
  if (!selected) {
    throw new CliError(`EAI 节点不存在：${nodeName}`, 1, {
      code: "INVALID_ARGUMENT",
      candidates: nodes.map((node) => node.name),
      requiredInput: "node"
    });
  }
  return {
    kind: "eadp.trans.node.v1",
    resource: "trans",
    environment: environment.name,
    graphContract,
    node: selected
  };
}

interface TransNodeDescription {
  name: string;
  nodeName: string;
  metaDescList: ResourceRecord[];
}

function parseNodes(value: unknown): TransNodeDescription[] {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    throw new CliError("资源接口返回格式无效：nodeDesc/getAllNodeDesc");
  }
  return Object.entries(value.data).map(([key, value]) => {
    if (!isRecord(value) || typeof value.name !== "string" ||
        typeof value.nodeName !== "string" || !Array.isArray(value.metaDescList)) {
      throw new CliError(`节点 ${key} 的描述格式无效`);
    }
    return {
      name: value.name,
      nodeName: value.nodeName,
      metaDescList: value.metaDescList.map((field) => describeField(key, field))
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function describeField(nodeName: string, value: unknown): ResourceRecord {
  if (!isRecord(value) || typeof value.code !== "string") {
    throw new CliError(`节点 ${nodeName} 的参数描述格式无效`);
  }
  if (value.code === "sourceSystemId") {
    return {
      ...value,
      writeField: "sourceSystemCode",
      writeRule: "使用来源系统业务 code，由 CLI 映射当前环境 ID"
    };
  }
  if (secretFields.has(value.code.toLocaleLowerCase())) {
    return { ...value, sensitive: true, writeRule: "CLI 不写入明文秘密" };
  }
  return { ...value };
}
