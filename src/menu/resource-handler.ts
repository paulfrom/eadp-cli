import type { ResolvedEnvironment } from "../config/resolve.js";
import { createResourceClient } from "../resource/core/client.js";
import type { ResourceQueryResult } from "../resource/core/engine.js";
import type { SpecialResourceHandler } from "../resource/handlers/contracts.js";
import {
  filterMenus,
  loadMenus,
  syncMenus
} from "./service.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import type { RuntimeOptions } from "../runtime-options.js";

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
  async compare({ source, target, runtime, selectors }) {
    const code = selectors.code;
    return syncMenus({
      sourceClient: createClient(source, runtime),
      targetClient: createClient(target, runtime),
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      ...(code === undefined ? {} : { code }),
      apply: false
    });
  },
  async sync({ source, target, operationStoreDirectory, runtime, selectors, apply }) {
    const code = selectors.code;
    const recorder = apply
      ? new OperationRecorder(
          new OperationLogStore(operationStoreDirectory),
          "eadp resource sync menu",
          target.name
        )
      : undefined;
    return syncMenus({
      sourceClient: createClient(source, runtime),
      targetClient: createClient(target, runtime),
      sourceEnvironment: source.name,
      targetEnvironment: target.name,
      ...(code === undefined ? {} : { code }),
      apply,
      ...(recorder ? { recorder } : {})
    });
  }
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
