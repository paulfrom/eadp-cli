import { BpmClient } from "./client.js";
import { syncBpmFlow } from "./sync.js";
import { CliError, errorMessage } from "../errors.js";
import { OperationRecorder } from "../operations/recorder.js";
import { OperationLogStore } from "../operations/store.js";
import type { ResolvedEnvironment } from "../config/resolve.js";
import type { RuntimeOptions } from "../runtime-options.js";
import type { SpecialResourceHandler } from "../resource/handlers/contracts.js";

export const bpmResourceHandler: SpecialResourceHandler = {
  async compare({ source, target, runtime, selectors }) {
    return runBpmSync({
      source,
      target,
      runtime,
      ...(selectors.flow === undefined ? {} : { flow: selectors.flow }),
      apply: false
    });
  },
  async sync({ source, target, operationStoreDirectory, runtime, selectors, apply }) {
    return runBpmSync({
      source,
      target,
      operationStoreDirectory,
      runtime,
      ...(selectors.flow === undefined ? {} : { flow: selectors.flow }),
      apply
    });
  }
};

async function runBpmSync(options: {
  source: ResolvedEnvironment;
  target: ResolvedEnvironment;
  operationStoreDirectory?: string;
  runtime: RuntimeOptions;
  flow?: string;
  apply: boolean;
}): Promise<Record<string, unknown>> {
  if (!options.flow || options.flow.trim() === "") {
    throw new CliError("resource bpm compare/sync 必须提供 --flow 流程代码、名称或 Entity 代码");
  }
  const recorder = options.apply && options.operationStoreDirectory
    ? new OperationRecorder(
        new OperationLogStore(options.operationStoreDirectory),
        "eadp resource sync bpm",
        options.target.name
      )
    : undefined;
  try {
    const result = await syncBpmFlow({
      sourceClient: new BpmClient({
        baseUrl: options.source.config.baseUrl,
        token: options.source.token,
        authorization: options.source.authorization,
        timeoutMs: options.runtime.timeoutMs
      }),
      targetClient: new BpmClient({
        baseUrl: options.target.config.baseUrl,
        token: options.target.token,
        authorization: options.target.authorization,
        timeoutMs: options.runtime.timeoutMs
      }),
      sourceEnvironment: options.source.name,
      targetEnvironment: options.target.name,
      selector: options.flow,
      apply: options.apply,
      ...(recorder ? { recorder } : {})
    });
    const operationId = await recorder?.complete();
    return { ...result, ...(operationId ? { operationId } : {}) };
  } catch (error) {
    await recorder?.fail(error);
    const suffix = recorder?.hasActions
      ? `；可使用 operation-id ${recorder.operationId} 回滚已新增记录`
      : "";
    throw new CliError(`${errorMessage(error)}${suffix}`);
  }
}
