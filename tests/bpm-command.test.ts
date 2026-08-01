import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { ConfigStore } from "../src/config/store.js";

const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("bpm configure", () => {
  it("在全新上下文中从项目清单完成幂等基础配置", async () => {
    const project = await createProjectFixture();
    const state = createBpmServerState();
    const server = createServer((request, response) =>
      handleBpmRequest(request, response, state)
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器启动失败");
    }

    const configDirectory = await mkdtemp(join(tmpdir(), "eadp-bpm-config-"));
    temporaryDirectories.push(configDirectory);
    const store = new ConfigStore(configDirectory);
    await store.save({
      currentEnvironment: "dev",
      environments: {
        dev: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "secret"
        }
      }
    });

    const args = [
      "bpm",
      "configure",
      "--project",
      project,
      "--flow",
      "TBS_PROJECT",
      "--apply",
      "--compact"
    ];
    await createProgram(store).parseAsync(args, { from: "user" });
    await createProgram(store).parseAsync(args, { from: "user" });

    expect(state.entities).toHaveLength(1);
    expect(state.pages).toHaveLength(3);
    expect(state.interfaces).toHaveLength(4);
    expect(state.flowTypes).toHaveLength(1);
    expect(state.pageRelations.get("entity-1")).toHaveLength(3);
    expect(state.interfaceRelations.get("entity-1")).toHaveLength(4);
  });
});

interface StoredItem {
  id: string;
  [key: string]: unknown;
}

interface BpmServerState {
  modules: StoredItem[];
  entities: StoredItem[];
  pages: StoredItem[];
  interfaces: StoredItem[];
  flowTypes: StoredItem[];
  pageRelations: Map<string, string[]>;
  interfaceRelations: Map<string, string[]>;
  sequence: number;
}

function createBpmServerState(): BpmServerState {
  return {
    modules: [
      {
        id: "module-1",
        code: "sdh-tbs",
        name: "川发贸易",
        serviceName: "sdh-tbs",
        webBaseAddress: "sdh-tbs-web"
      }
    ],
    entities: [],
    pages: [],
    interfaces: [],
    flowTypes: [],
    pageRelations: new Map(),
    interfaceRelations: new Map(),
    sequence: 1
  };
}

async function handleBpmRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: BpmServerState
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const body = await readBody(request);
  const collections: Record<string, StoredItem[]> = {
    conBusinessModule: state.modules,
    conBusinessEntity: state.entities,
    conPage: state.pages,
    conInterface: state.interfaces,
    conFlowType: state.flowTypes
  };
  const resource = Object.keys(collections).find((name) => path.includes(`/${name}/`));
  if (resource && path.endsWith("/findByPage")) {
    respond(response, {
      success: true,
      data: { page: 1, records: collections[resource]!.length, rows: collections[resource] }
    });
    return;
  }
  if (resource && path.endsWith("/save")) {
    const item = { ...(body as Record<string, unknown>), id: `${resource}-${state.sequence++}` };
    if (resource === "conBusinessEntity") {
      item.id = "entity-1";
    }
    collections[resource]!.push(item);
    respond(response, { success: true, data: item });
    return;
  }
  if (path.endsWith("/findByBusinessEntityId")) {
    const entityId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
      "businessEntityId"
    );
    respond(response, {
      success: true,
      data: state.flowTypes.filter((item) => item.businessEntityId === entityId)
    });
    return;
  }
  const relation = path.includes("/conEntityPage/")
    ? state.pageRelations
    : path.includes("/conEntityInterface/")
      ? state.interfaceRelations
      : undefined;
  if (relation && path.endsWith("/getChildrenFromParentId")) {
    const parentId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
      "parentId"
    )!;
    const source = path.includes("/conEntityPage/") ? state.pages : state.interfaces;
    const childIds = relation.get(parentId) ?? [];
    respond(response, {
      success: true,
      data: source.filter((item) => childIds.includes(item.id))
    });
    return;
  }
  if (relation && path.endsWith("/insertRelations")) {
    const input = body as { parentId: string; childIds: string[] };
    const existing = relation.get(input.parentId) ?? [];
    relation.set(input.parentId, [...new Set([...existing, ...input.childIds])]);
    respond(response, { success: true, data: "ok" });
    return;
  }
  respond(response, { success: false, message: `未模拟接口：${path}` }, 404);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? JSON.parse(source) : undefined;
}

function respond(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function createProjectFixture(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "eadp-bpm-project-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, "backend"), { recursive: true });
  await mkdir(join(project, "docs", "contracts"), { recursive: true });
  await writeFile(
    join(project, "backend", "settings.gradle"),
    "rootProject.name = 'sdh-tbs'\n",
    "utf8"
  );
  await writeFile(
    join(project, "docs", "contracts", "BPM流程配置登记册.md"),
    `# BPM 流程配置登记册

| 项 | 值 |
|----|-----|
| 关联业务模块 | 贸易业务系统 |

## 1. 项目申请

**流程模型**：\`TBS_PROJECT\`

### 业务实体
| 名称 | 代码 | 接口名 | PC 查看单据 url | 移动端查看单据 url |
|---|---|---|---|---|
| 项目申请 | \`com.sdh.tbs.project.entity.Project\` | \`project\` | \`/project/apply/detail\` | |

### 集成接口
| 名称 | 方法 | 接口类型 |
|---|---|---|
| 项目申请-流程启动前事件 | \`project/beforeStartFlow\` | 事件 |
| 项目申请-流程启动后事件 | \`project/afterStartFlow\` | 事件 |
| 项目申请-流程结束前事件 | \`project/beforeEndFlow\` | 事件 |
| 项目申请-流程结束后事件 | \`project/afterEndFlow\` | 事件 |

### 工作页面
| 名称 | pc 端处理 url |
|---|---|
| 项目申请-流程中编辑 | \`/project/apply/approve/edit\` |
| 项目申请-流程中查看 | \`/project/apply/approve/view\` |
| 项目申请-已办查看 | \`/project/apply/detail\`（不套流程） |
`,
    "utf8"
  );
  return project;
}
