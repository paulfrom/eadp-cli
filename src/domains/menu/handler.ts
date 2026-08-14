import type { ResolvedEnvironment } from "../../config/resolve.js";
import { createResourceClient } from "../../resource/core/client.js";
import type { ResourceQueryResult } from "../../resource/core/engine.js";
import type { SpecialResourceHandler } from "../../resource/handlers/contracts.js";
import {
  filterMenus,
  loadMenus,
  menuPhaseHooks
} from "./service.js";
import type { RuntimeOptions } from "../../runtime-options.js";

export const menuResourceHandler: SpecialResourceHandler = {
  async query({ environment, runtime, filters, quick }): Promise<ResourceQueryResult> {
    const menus = await loadMenus(createClient(environment, runtime));
    const items = filterMenus(menus, filters, quick);
    return {
      kind: "eadp.resource.query.v1",
      resource: "menu",
      environment: environment.name,
      items,
      total: items.length
    };
  },
  hooks: menuPhaseHooks
};

function createClient(
  environment: ResolvedEnvironment,
  runtime: RuntimeOptions
): ReturnType<typeof createResourceClient> {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service: "sei-basic",
    timeoutMs: runtime.timeoutMs
  });
}
