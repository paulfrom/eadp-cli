import { describe, expect, it } from "vitest";
import {
  assertPathTenantScope,
  assertTenantScope,
  scopeForPath
} from "../src/tenant.js";

describe("tenant operation policy", () => {
  it("功能项、菜单和给号配置路径属于 global 操作", () => {
    expect(scopeForPath("/api-gateway/sei-basic/feature/findByPage")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/appModule/findAll")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/featureGroup/findAll")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/menu/getMenuTree")).toBe("global");
    expect(scopeForPath("/api-gateway/sei-basic/serialNumberConfig/save")).toBe("global");
  });

  it("权限角色、用户和 BPM 路径属于非 global 操作", () => {
    expect(scopeForPath("/api-gateway/sei-basic/featureRole/findByPage")).toBe("non-global");
    expect(scopeForPath("/api-gateway/sei-basic/user/getFeatureRolesByAccount")).toBe("non-global");
    expect(scopeForPath("/api-gateway/sei-bpm/conBusinessEntity/findByPage")).toBe("non-global");
  });

  it("阻止不匹配的租户执行操作", () => {
    expect(() => assertPathTenantScope("tenant-a", "/feature/findByPage", "dev")).toThrow(
      "必须使用 global 租户"
    );
    expect(() => assertPathTenantScope("global", "/featureRole/findByPage", "dev")).toThrow(
      "必须使用非 global 租户"
    );
    expect(() => assertTenantScope(undefined, "non-global", "dev")).toThrow(
      "请重新执行 env add 验证 Token"
    );
  });
});
