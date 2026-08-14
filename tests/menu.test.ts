/**
 * menu 必测矩阵：
 * - query 使用 getMenuTree 并输出带 parentCode 的扁平结果
 * - 按 code 查重（新增不覆盖已有菜单）
 * - 父先子后处理；重新映射 parentId / featureId（禁止复制源 ID）
 * - 缺功能项标记 blocked（missingDependencies）
 */
import { afterEach, describe, expect, it } from "vitest";
import { OperationLogStore } from "../src/operations/store.js";
import {
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

interface MenuTreeState {
  roots: Array<Record<string, unknown>>;
  saves: unknown[];
  moves: unknown[];
  features: Array<Record<string, unknown>>;
  saveFails?: boolean;
  /** 可选的 save 处理器，覆盖默认保存逻辑（用于回查场景）。 */
  saveHandler?: (context: import("./helpers/index.js").RouteContext) => void | Promise<void>;
  /** 可选的 move 处理器，覆盖默认移动逻辑（用于回查场景）。 */
  moveHandler?: (context: import("./helpers/index.js").RouteContext) => void | Promise<void>;
}

function menuState(features: Array<Record<string, unknown>> = []): MenuTreeState {
  return { roots: [], saves: [], moves: [], features };
}

/** 生成带 children 的菜单树。 */
function menuNode(
  overrides: Record<string, unknown>,
  children: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  return { id: `id-${String(overrides.code)}`, rank: 0, children, ...overrides };
}

function registerMenuTreeRoutes(server: MockEadpServer, state: MenuTreeState): void {
  server.onEndsWith("/menu/getMenuTree", (context) => context.json(state.roots));
  server.onEndsWith("/feature/findByPage", (context) => {
    const rows = state.features;
    context.json({ rows, total: rows.length });
  });
  server.onEndsWith("/menu/save", async (context) => {
    if (state.saveHandler) {
      await state.saveHandler(context);
      return;
    }
    if (state.saveFails) {
      context.fail("save failed", 500);
      return;
    }
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const saved = { ...body, id: `target-${String(body.code ?? "generated")}` };
    context.json(saved);
  });
  server.onEndsWith("/menu/move", async (context) => {
    if (state.moveHandler) {
      await state.moveHandler(context);
      return;
    }
    state.moves.push(context.body);
    context.json("移动成功");
  });
  server.onEndsWith("/menu/findOne", (context) => {
    const id = context.query.get("id");
    const found = findMenuById(state.roots, id);
    context.json(found ?? null);
  });
  server.on(/\/menu\/delete\/[^/]+$/, (context) => {
    const id = context.path.split("/").at(-1);
    removeMenuById(state.roots, id);
    context.json(true);
  });
}

function findMenuById(menus: Array<Record<string, unknown>>, id: string | null | undefined): Record<string, unknown> | undefined {
  if (!id) return undefined;
  for (const menu of menus) {
    if (menu.id === id) return menu;
    const children = menu.children;
    if (Array.isArray(children)) {
      const found = findMenuById(children as Array<Record<string, unknown>>, id);
      if (found) return found;
    }
  }
  return undefined;
}

function removeMenuById(menus: Array<Record<string, unknown>>, id: string | undefined): boolean {
  if (!id) return false;
  const index = menus.findIndex((menu) => menu.id === id);
  if (index >= 0) {
    menus.splice(index, 1);
    return true;
  }
  for (const menu of menus) {
    const children = menu.children;
    if (Array.isArray(children) && removeMenuById(children as Array<Record<string, unknown>>, id)) {
      return true;
    }
  }
  return false;
}

/** 从任意层级移除指定 id 的子节点。 */
function removeMenuChild(menus: Array<Record<string, unknown>>, id: string | undefined): boolean {
  if (!id) return false;
  for (const menu of menus) {
    const children = menu.children;
    if (!Array.isArray(children)) continue;
    const index = children.findIndex((child) => child.id === id);
    if (index >= 0) {
      (children as Array<Record<string, unknown>>).splice(index, 1);
      return true;
    }
    if (removeMenuChild(children as Array<Record<string, unknown>>, id)) return true;
  }
  return false;
}

describe("menu query", () => {
  it("query 使用菜单树接口并输出带 parentCode 的扁平结果", async () => {
    const fixture = await createFixture();
    const state = menuState();
    state.roots = [menuNode({ code: "PURCHASE", name: "采购管理" }, [
      menuNode({ code: "PURCHASE_APPLY", name: "采购申请", rank: 1 })
    ])];
    registerMenuTreeRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "menu", "--env", "source", "--quick", "申请"
    ])) as { items: Array<Record<string, unknown>>; total: number };
    expect(output.total).toBe(1);
    expect(output.items[0]).toMatchObject({ code: "PURCHASE_APPLY", parentCode: "PURCHASE" });
  });
});

describe("menu create：六大场景", () => {
  it("场景1 预览：解析依赖但不写入，输出计划", async () => {
    const fixture = await createFixture();
    const state = menuState([{ id: "feature-target-id", code: "PURCHASE_APPLY" }]);
    state.roots = [menuNode({ code: "PURCHASE", name: "采购管理" })];
    registerMenuTreeRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "采购申请",
      "--code", "PURCHASE_APPLY", "--parent-code", "PURCHASE", "--feature-code", "PURCHASE_APPLY"
    ])) as { applied: boolean; action: string; desired: Record<string, unknown> };
    expect(output.applied).toBe(false);
    expect(output.action).toBe("create");
    expect(output.desired).toMatchObject({
      code: "PURCHASE_APPLY",
      parentCode: "PURCHASE",
      featureCode: "PURCHASE_APPLY"
    });
    expect(state.saves).toHaveLength(0);
  });

  it("场景2+3 正式执行：断言完整请求体（重映射 ID）并回查，产生可回滚 operationId", async () => {
    const fixture = await createFixture();
    const state = menuState([{ id: "feature-target-id", code: "PURCHASE_APPLY" }]);
    state.roots = [menuNode({ code: "PURCHASE", name: "采购管理" })];
    registerMenuTreeRoutes(fixture.server("source"), state);
    // save 后把新建菜单加入树，回查才能看到
    state.saveHandler = (context) => {
      const body = context.body as Record<string, unknown>;
      state.saves.push(body);
      const saved = { ...body, id: "menu-new-id", code: body.code, featureCode: "PURCHASE_APPLY" };
      const parent = findMenuById(state.roots, String(body.parentId));
      if (parent) {
        (parent.children as Array<Record<string, unknown>>).push({ ...saved, children: [] });
      } else {
        state.roots.push({ ...saved, children: [] });
      }
      context.json(saved);
    };

    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "采购申请",
      "--code", "PURCHASE_APPLY", "--parent-code", "PURCHASE", "--feature-code", "PURCHASE_APPLY",
      "--rank", "10", "--apply"
    ])) as { applied: boolean; action: string; verified: boolean; operationId: string };

    expect(output.applied).toBe(true);
    expect(output.action).toBe("create");
    expect(output.verified).toBe(true);
    expect(state.saves).toHaveLength(1);
    // 完整请求体：parentId/featureId 使用目标解析结果，不含源 ID
    expect(state.saves[0]).toEqual({
      code: "PURCHASE_APPLY",
      name: "采购申请",
      parentId: "id-PURCHASE",
      featureId: "feature-target-id",
      rank: 10
    });
    // 回查后服务端状态存在该菜单
    expect(findMenuById(state.roots, "menu-new-id")).toBeTruthy();

    const record = await new OperationLogStore(fixture.store.directory).load(output.operationId);
    expect(record.actions).toEqual([
      expect.objectContaining({ type: "create-entity", resource: "menu", entityId: "menu-new-id" })
    ]);
  });

  it("场景4 再次执行：同 code 同字段返回 unchanged 且零写入；字段冲突则报错不覆盖", async () => {
    const fixture = await createFixture();
    const state = menuState();
    state.roots = [menuNode({ code: "PURCHASE_APPLY", name: "采购申请", rank: 0 })];
    registerMenuTreeRoutes(fixture.server("source"), state);

    const unchanged = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "采购申请",
      "--code", "PURCHASE_APPLY", "--apply"
    ])) as { applied: boolean; action: string; verified: boolean };
    expect(unchanged.applied).toBe(false);
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.verified).toBe(true);
    expect(state.saves).toHaveLength(0);

    const conflict = await runExpectError(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "不同名称",
      "--code", "PURCHASE_APPLY", "--apply"
    ]);
    expect(conflict).toContain("已存在且字段不同");
    expect(state.saves).toHaveLength(0);
  });

  it("场景5 歧义/依赖：父菜单不存在或已绑定功能项时报错且零写入", async () => {
    const fixture = await createFixture();
    const state = menuState();
    state.roots = [menuNode({ code: "PURCHASE", name: "采购管理", featureCode: "FEATURE_X" })];
    registerMenuTreeRoutes(fixture.server("source"), state);

    const error = await runExpectError(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "子菜单",
      "--code", "CHILD", "--parent-code", "PURCHASE", "--apply"
    ]);
    expect(error).toContain("已绑定功能项，不能作为父菜单");
    expect(state.saves).toHaveLength(0);

    const missing = await runExpectError(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "子菜单",
      "--code", "CHILD", "--parent-code", "MISSING_PARENT", "--apply"
    ]);
    expect(missing).toContain("父菜单 code=MISSING_PARENT 不存在");
    expect(state.saves).toHaveLength(0);
  });

  it("场景6 失败：save 失败立即停止且不重试", async () => {
    const fixture = await createFixture();
    const state = menuState();
    state.saveFails = true;
    registerMenuTreeRoutes(fixture.server("source"), state);
    const before = fixture.server("source").requests.length;
    const error = await runExpectError(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "菜单", "--code", "M1", "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    const newRequests = fixture.server("source").requests.slice(before);
    expect(newRequests.filter((request) => request.path.endsWith("/menu/save"))).toHaveLength(1);
  });

  it("菜单 code 超过 20 字符时拒绝且零远端请求", async () => {
    const fixture = await createFixture();
    const state = menuState();
    registerMenuTreeRoutes(fixture.server("source"), state);
    const error = await runExpectError(fixture.program(), [
      "--compact", "menu", "create", "--env", "source", "--name", "超长菜单",
      "--code", "ABCDEFGHIJKLMNOPQRSTU", "--apply"
    ]);
    expect(error).toContain("菜单 code 最多20个字符");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});

describe("menu sync：父先子后与 ID 重映射", () => {
  it("按父先子后新增，parentId/featureId 重映射为目标 ID，且幂等", async () => {
    const fixture = await createFixture();
    const source = menuState();
    source.roots = [menuNode(
      { code: "PURCHASE", name: "采购管理" },
      [menuNode({
        code: "PURCHASE_APPLY", name: "采购申请", rank: 1,
        parentId: "source-root-id", featureId: "source-feature-id", featureCode: "PURCHASE_APPLY"
      })]
    )];
    const target = menuState([{ id: "target-feature-id", code: "PURCHASE_APPLY" }]);
    registerMenuTreeRoutes(fixture.server("source"), source);
    // 目标 save 后加入目标树，便于回查
    target.saveHandler = (context) => {
      const body = context.body as Record<string, unknown>;
      target.saves.push(body);
      const saved = {
        ...body,
        id: `target-${String(body.code)}`,
        ...(body.featureId ? { featureCode: "PURCHASE_APPLY" } : {}),
        children: []
      };
      if (body.parentId) {
        const parent = findMenuById(target.roots, String(body.parentId));
        (parent?.children as Array<Record<string, unknown>> | undefined)?.push(saved);
        if (!parent) target.roots.push(saved);
      } else {
        target.roots.push(saved);
      }
      context.json(saved);
    };
    registerMenuTreeRoutes(fixture.server("target"), target);

    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "menu", "--source", "source", "--target", "target",
      "--code", "PURCHASE", "--apply"
    ])) as {
      summary: Record<string, number>;
      applied: boolean;
      verified: boolean;
      operationId: string;
    };
    expect(output.summary).toEqual({ create: 2, update: 0, unchanged: 0, blocked: 0 });
    expect(output.applied).toBe(true);
    expect(output.verified).toBe(true);
    // 父先子后：先保存父（无 parentId），再保存子（parentId=目标父 ID）
    expect(target.saves[0]).toMatchObject({ code: "PURCHASE", name: "采购管理" });
    expect(target.saves[0]).not.toHaveProperty("id");
    expect(target.saves[1]).toMatchObject({
      code: "PURCHASE_APPLY",
      parentId: "target-PURCHASE",
      featureId: "target-feature-id"
    });
    expect(target.saves[1]).not.toMatchObject({
      parentId: "source-root-id",
      featureId: "source-feature-id"
    });
    // 幂等
    const again = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "menu", "--source", "source", "--target", "target",
      "--code", "PURCHASE", "--apply"
    ])) as { summary: Record<string, number> };
    expect(again.summary).toEqual({ create: 0, update: 0, unchanged: 2, blocked: 0 });
    expect(target.saves).toHaveLength(2);
    const record = await new OperationLogStore(fixture.store.directory).load(output.operationId);
    expect(record.actions.map((action) => action.entityId)).toEqual([
      "target-PURCHASE", "target-PURCHASE_APPLY"
    ]);
  });

  it("完成全量预览并将缺功能项的菜单标记 blocked", async () => {
    const fixture = await createFixture();
    const source = menuState();
    source.roots = [
      menuNode({ code: "SAFE", name: "安全菜单" }),
      menuNode({ code: "BLOCKED", name: "阻断菜单", featureId: "source-feature", featureCode: "MISSING_FEATURE" })
    ];
    const target = menuState();
    registerMenuTreeRoutes(fixture.server("source"), source);
    registerMenuTreeRoutes(fixture.server("target"), target);

    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "menu", "--source", "source", "--target", "target"
    ])) as {
      summary: Record<string, number>;
      applied: boolean;
      changes: Array<Record<string, unknown>>;
      missingDependencies: Array<Record<string, unknown>>;
    };
    expect(output.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(output.applied).toBe(false);
    expect(output.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "SAFE", action: "create" }),
      expect.objectContaining({
        key: "BLOCKED",
        action: "blocked",
        missingDependencies: [{ resource: "feature", identityField: "code", value: "MISSING_FEATURE", reason: "missing" }]
      })
    ]));
    expect(output.missingDependencies).toEqual([
      { resource: "feature", identityField: "code", value: "MISSING_FEATURE", reason: "missing" }
    ]);
    expect(target.saves).toHaveLength(0);
  });

  it("更新字段并换父节点时先按原 parentId 保存再调用 move", async () => {
    const fixture = await createFixture();
    const source = menuState();
    source.roots = [
      menuNode({ code: "A", name: "菜单A" }),
      menuNode({ code: "B", name: "菜单B" }, [
        menuNode({ code: "CHILD", name: "新名称", rank: 0, parentCode: "B" })
      ])
    ];
    const target = menuState();
    target.roots = [
      menuNode({ id: "target-a", code: "A", name: "菜单A" }, [
        menuNode({ id: "target-child", code: "CHILD", name: "旧名称", rank: 0, parentId: "target-a" })
      ]),
      menuNode({ id: "target-b", code: "B", name: "菜单B" })
    ];
    registerMenuTreeRoutes(fixture.server("source"), source);
    // save 更新目标树中的子菜单，move 换父节点（回查依赖服务端真实状态）
    target.saveHandler = (context) => {
      const body = context.body as Record<string, unknown>;
      target.saves.push(body);
      const child = findMenuById(target.roots, "target-child");
      Object.assign(child ?? {}, body);
      context.json(child ?? body);
    };
    target.moveHandler = (context) => {
      target.moves.push(context.body);
      const body = context.body as { nodeId: string; targetId: string };
      const child = findMenuById(target.roots, body.nodeId);
      if (child) {
        removeMenuChild(target.roots, child.id);
        if (body.targetId) {
          const parent = findMenuById(target.roots, body.targetId);
          (parent?.children as Array<Record<string, unknown>> | undefined)?.push(child);
          child.parentId = body.targetId;
        } else {
          child.parentId = null;
          delete child.parentId;
          target.roots.push(child);
        }
      }
      context.json("移动成功");
    };
    registerMenuTreeRoutes(fixture.server("target"), target);

    const output = JSON.parse(await runCommand(fixture.program(), [
      "--compact", "resource", "sync", "menu", "--source", "source", "--target", "target", "--apply"
    ])) as { summary: Record<string, number>; verified: boolean };
    expect(output.summary).toEqual({ create: 0, update: 1, unchanged: 2, blocked: 0 });
    expect(output.verified).toBe(true);
    // save 使用原 parentId，随后 move 到新父节点
    expect(target.saves[0]).toMatchObject({ code: "CHILD", parentId: "target-a" });
    expect(target.moves).toEqual([
      { nodeId: "target-child", targetId: "target-b", moveType: "ACROSS_LEVEL" }
    ]);
  });

  it("同步涉及超长菜单 code 时失败且不写入目标", async () => {
    const fixture = await createFixture();
    const source = menuState();
    source.roots = [menuNode({ code: "SAFE", name: "安全菜单" }, [
      menuNode({ code: "ABCDEFGHIJKLMNOPQRSTU", name: "超长菜单", rank: 1 })
    ])];
    const target = menuState();
    registerMenuTreeRoutes(fixture.server("source"), source);
    registerMenuTreeRoutes(fixture.server("target"), target);

    const error = await runExpectError(fixture.program(), [
      "--compact", "resource", "sync", "menu", "--source", "source", "--target", "target", "--apply"
    ]);
    expect(error).toContain("菜单 code 最多20个字符");
    expect(target.saves).toHaveLength(0);
  });
});
