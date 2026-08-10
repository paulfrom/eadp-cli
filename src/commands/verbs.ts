import type { Command } from "commander";

export interface VerbCommands {
  inspect: Command;
  query: Command;
  call: Command;
  apply: Command;
  assign: Command;
  revoke: Command;
  sync: Command;
  verify: Command;
}

export function registerVerbCommands(program: Command): VerbCommands {
  return {
    inspect: program.command("inspect").description("查看目录、项目或权限配置"),
    query: program.command("query").description("查询 EADP 资源数据"),
    call: program.command("call").description("调用已登记接口或指定 HTTP 方法和路径"),
    apply: program.command("apply").description("预览或应用配置变更"),
    assign: program.command("assign").description("预览或分配权限关系"),
    revoke: program.command("revoke").description("预览或移除权限关系"),
    sync: program.command("sync").description("预览或同步环境间资源"),
    verify: program.command("verify").description("校验用户的最终权限")
  };
}
