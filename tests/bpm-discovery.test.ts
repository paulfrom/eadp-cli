import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBpmProject, selectBpmFlow } from "../src/domains/bpm/discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("BPM 项目发现", () => {
  it("明确选择唯一 Entity 全限定名时不受流程候选清单限制", async () => {
    const project = await mkdtemp(join(tmpdir(), "eadp-bpm-entity-only-"));
    temporaryDirectories.push(project);
    await writeJava(project, "com/sdh/tbs/qualification/entity/QualificationFileApply.java", `
package com.sdh.tbs.qualification.entity;
public class QualificationFileApply extends BaseFlowEntity { }
`);

    const definition = await discoverBpmProject(
      project,
      "com.sdh.tbs.qualification.entity.QualificationFileApply"
    );

    expect(definition.flows).toEqual([{
      name: "QualificationFileApply",
      code: "com.sdh.tbs.qualification.entity.QualificationFileApply",
      entity: {
        name: "QualificationFileApply",
        code: "com.sdh.tbs.qualification.entity.QualificationFileApply",
        serviceName: "qualificationFileApply"
      },
      interfaces: [],
      pages: []
    }]);
  });

  it("没有 BPM 回调和 startDefaultFlow 时仍从流程骨架发现流程", async () => {
    const project = await mkdtemp(join(tmpdir(), "eadp-bpm-skeleton-"));
    temporaryDirectories.push(project);
    await writeJava(project, "com/sdh/tbs/qualification/api/QualificationFileApplyApi.java", `
package com.sdh.tbs.qualification.api;
public interface QualificationFileApplyApi { String PATH = "/qualificationFileApply"; }
`);
    await writeJava(project, "com/sdh/tbs/qualification/entity/QualificationFileApply.java", `
package com.sdh.tbs.qualification.entity;
public class QualificationFileApply extends BaseFlowEntity { }
`);
    await writeJava(project, "com/sdh/tbs/qualification/controller/QualificationFileApplyController.java", `
package com.sdh.tbs.qualification.controller;
import com.sdh.tbs.qualification.api.QualificationFileApplyApi;
import com.sdh.tbs.qualification.entity.QualificationFileApply;
@Tag(name = "QualificationFileApplyApi", description = "资质文件申请服务")
@RequestMapping(path = QualificationFileApplyApi.PATH)
public class QualificationFileApplyController extends BaseFlowController<QualificationFileApply, QualificationFileApplyDto> {
}
`);

    const definition = await discoverBpmProject(project);

    expect(definition.flows).toEqual([
      {
        name: "资质文件申请",
        code: "com.sdh.tbs.qualification.entity.QualificationFileApply",
        entity: {
          name: "资质文件申请",
          code: "com.sdh.tbs.qualification.entity.QualificationFileApply",
          serviceName: "qualificationFileApply"
        },
        interfaces: [],
        pages: []
      }
    ]);
    expect(() => selectBpmFlow(definition, "资质文件申请")).toThrow("未找到流程");
  });

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
