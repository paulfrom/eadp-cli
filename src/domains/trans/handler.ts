import type { ResolvedEnvironment } from "../../config/resolve.js";
import { createResourceClient, type ResourceClient } from "../../resource/core/client.js";
import type { ResourceQueryResult } from "../../resource/core/engine.js";
import type { SpecialResourceHandler } from "../../resource/handlers/contracts.js";
import type { RuntimeOptions } from "../../runtime-options.js";
import { transContract } from "./contract.js";
import { sanitizeTransOutput, transPhaseHooks } from "./service.js";

export const transResourceHandler: SpecialResourceHandler = {
  async query({ environment, runtime, filters, quick }): Promise<ResourceQueryResult> {
    const client = createClient(environment, runtime);
    const items = await client.queryContract(transContract, {
      filters,
      ...(quick === undefined ? {} : { quickSearchValue: quick })
    });
    return {
      kind: "eadp.resource.query.v1",
      resource: "trans",
      environment: environment.name,
      items: sanitizeTransOutput(items) as ResourceQueryResult["items"],
      total: items.length
    };
  },
  hooks: transPhaseHooks,
  sanitizeOutput: sanitizeTransOutput
};

function createClient(environment: ResolvedEnvironment, runtime: RuntimeOptions): ResourceClient {
  return createResourceClient({
    baseUrl: environment.config.baseUrl,
    token: environment.token,
    authorization: environment.authorization,
    service: "sei-eai",
    timeoutMs: runtime.timeoutMs
  });
}
