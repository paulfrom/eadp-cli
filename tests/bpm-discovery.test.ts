import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  it("不依赖登记册，仅从真实 BPM 代码发现可配置流程", async () => {
    const project = await mkdtemp(join(tmpdir(), "eadp-bpm-project-"));
    temporaryDirectories.push(project);
    await mkdir(join(project, "backend"), { recursive: true });
    await writeFile(
      join(project, "backend", "settings.gradle"),
      "rootProject.name = 'sdh-tbs'\n",
      "utf8"
    );
    await writeJava(project, "com/sdh/tbs/project/api/ProjectApi.java", `
package com.sdh.tbs.project.api;
public interface ProjectApi { String PATH = "/project"; }
`);
    await writeJava(project, "com/sdh/tbs/project/entity/Project.java", `
package com.sdh.tbs.project.entity;
public class Project extends BaseFlowEntity { }
`);
    await writeJava(project, "com/sdh/tbs/project/controller/ProjectController.java", `
package com.sdh.tbs.project.controller;
import com.sdh.tbs.project.api.ProjectApi;
import com.sdh.tbs.project.entity.Project;
@Tag(name = "ProjectApi", description = "项目申请服务")
@RequestMapping(path = ProjectApi.PATH)
public class ProjectController extends BaseFlowController<Project, ProjectDto> {
  public ResultData<Void> beforeStartFlow(BpmInvokeParams params) {
    return service.validateBeforeStart(params.getBusinessId());
  }
  public ResultData<Void> afterEndFlow(BpmInvokeParams params) {
    service.createProject(params.getBusinessId());
    return ResultData.success();
  }
  public ResultData<List<Executor>> getProjectLeaders(BpmInvokeParams params) {
    return service.getProjectLeaders(params.getBusinessId());
  }
}
`);
    await writeJava(project, "com/sdh/tbs/project/service/ProjectService.java", `
package com.sdh.tbs.project.service;
public class ProjectService {
  public void start(Project entity) {
    bpmClient.startDefaultFlow(new DefaultStartParam(Project.class.getName(), entity.getId()));
  }
}
`);
    await writeJava(project, "com/sdh/tbs/demo/controller/EmptyFlowController.java", `
package com.sdh.tbs.demo.controller;
import com.sdh.tbs.demo.entity.EmptyFlow;
@RequestMapping(path = "/empty")
public class EmptyFlowController extends BaseFlowController<EmptyFlow, EmptyFlowDto> {
  public ResultData<Void> afterEndFlow(BpmInvokeParams params) {
    return ResultData.success();
  }
}
`);

    const definition = await discoverBpmProject(project);

    expect(definition.businessModule).toEqual({
      code: "sdh-tbs",
      name: "sdh-tbs",
      serviceName: "sdh-tbs"
    });
    expect(definition.sourcePath).toBe(project);
    expect(definition.flows).toHaveLength(1);
    expect(definition.flows[0]).toEqual({
      name: "项目申请",
      code: "com.sdh.tbs.project.entity.Project",
      entity: {
        name: "项目申请",
        code: "com.sdh.tbs.project.entity.Project",
        serviceName: "project"
      },
      interfaces: [
        {
          name: "项目申请-流程启动前事件",
          url: "project/beforeStartFlow",
          interfaceType: "EVENT"
        },
        {
          name: "项目申请-流程结束后事件",
          url: "project/afterEndFlow",
          interfaceType: "EVENT"
        },
        {
          name: "项目申请-getProjectLeaders",
          url: "project/getProjectLeaders",
          interfaceType: "CUSTOM_PERSON"
        }
      ],
      pages: []
    });
  });
});

async function writeJava(project: string, relativePath: string, source: string): Promise<void> {
  const file = join(project, "backend", "src", "main", "java", relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source.trimStart(), "utf8");
}
