import type { Command } from "commander";

export interface VerbCommands {
  inspect: Command;
  call: Command;
}

export interface PermissionVerbCommands {
  inspect: Command;
  apply: Command;
  assign: Command;
  revoke: Command;
  verify: Command;
}

export function registerVerbCommands(program: Command): VerbCommands {
  return {
    inspect: program.command("inspect").description("查看已登记接口"),
    call: program.command("call").description("调用已登记接口或指定 HTTP 方法和路径")
  };
}

export function registerPermissionVerbCommands(program: Command): PermissionVerbCommands {
  const permission = program
    .command("permission")
    .description("查询、配置、分配、撤销和验证权限");
  return {
    inspect: permission.command("inspect").description("查看权限配置"),
    apply: permission.command("apply").description("预览或应用权限配置"),
    assign: permission.command("assign").description("预览或分配权限关系"),
    revoke: permission.command("revoke").description("预览或移除权限关系"),
    verify: permission.command("verify").description("校验用户的最终权限")
  };
}
