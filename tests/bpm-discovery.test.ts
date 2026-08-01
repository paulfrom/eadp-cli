import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBpmProject } from "../src/bpm/discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("BPM 项目发现", () => {
  it("仅通过项目路径解析登记册并生成结构化流程配置", async () => {
    const project = await mkdtemp(join(tmpdir(), "eadp-bpm-project-"));
    temporaryDirectories.push(project);
    await mkdir(join(project, "backend"), { recursive: true });
    await mkdir(join(project, "frontend"), { recursive: true });
    await mkdir(join(project, "docs", "contracts"), { recursive: true });
    await writeFile(
      join(project, "backend", "settings.gradle"),
      "rootProject.name = 'sdh-tbs'\n",
      "utf8"
    );
    await writeFile(
      join(project, "frontend", "package.json"),
      JSON.stringify({ name: "sdh-tbs-web" }),
      "utf8"
    );
    await writeFile(
      join(project, "docs", "contracts", "BPM流程配置登记册.md"),
      registryMarkdown(),
      "utf8"
    );

    const definition = await discoverBpmProject(project);

    expect(definition.businessModule).toEqual({
      code: "sdh-tbs",
      name: "贸易业务系统",
      serviceName: "sdh-tbs",
      webBaseAddress: "sdh-tbs-web"
    });
    expect(definition.flows).toHaveLength(1);
    expect(definition.flows[0]).toMatchObject({
      name: "项目申请",
      code: "TBS_PROJECT",
      entity: {
        name: "项目申请",
        code: "com.sdh.tbs.project.entity.Project",
        serviceName: "project",
        pcLookUrl: "/project/apply/detail"
      }
    });
    expect(definition.flows[0]?.interfaces.map((item) => item.url)).toEqual([
      "project/beforeStartFlow",
      "project/afterStartFlow",
      "project/beforeEndFlow",
      "project/afterEndFlow"
    ]);
    expect(definition.flows[0]?.pages.map((item) => item.pcUrl)).toEqual([
      "/project/apply/approve/edit",
      "/project/apply/approve/view",
      "/project/apply/detail"
    ]);
  });
});

function registryMarkdown(): string {
  return `# BPM 流程配置登记册

**全局固定值**

| 项 | 值 |
|----|-----|
| 关联业务模块 | 贸易业务系统 |

## 1. 项目申请

**流程模型**：\`TBS_PROJECT\`

### 业务实体

| 名称 | 代码 | 接口名 | PC 查看单据 url | 移动端查看单据 url |
|------|------|--------|-----------------|-------------------|
| 项目申请 | \`com.sdh.tbs.project.entity.Project\` | \`project\` | \`/project/apply/detail\` | |

### 集成接口

| 名称 | 方法 | 接口类型 |
|------|------|----------|
| 项目申请-流程启动前事件 | \`project/beforeStartFlow\` | 事件 |
| 项目申请-流程启动后事件 | \`project/afterStartFlow\` | 事件 |
| 项目申请-流程结束前事件 | \`project/beforeEndFlow\` | 事件 |
| 项目申请-流程结束后事件 | \`project/afterEndFlow\` | 事件 |

### 工作页面

| 名称 | pc 端处理 url |
|------|---------------|
| 项目申请-流程中编辑 | \`/project/apply/approve/edit\` |
| 项目申请-流程中查看 | \`/project/apply/approve/view\` |
| 项目申请-已办查看 | \`/project/apply/detail\`（不套流程） |
`;
}
