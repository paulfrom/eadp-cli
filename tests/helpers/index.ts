/** 统一测试工具入口：共享 mock 服务器、夹具、运行与生命周期辅助。 */
export {
  MockEadpServer,
  createMockServer,
  eadpPage
} from "./server.js";
export type {
  CapturedRequest,
  PathMatcher,
  RouteContext,
  RouteHandler,
  TenantInfo
} from "./server.js";
export {
  createFixture
} from "./fixture.js";
export type {
  FixtureEnvironment,
  FixtureOptions,
  TestFixture
} from "./fixture.js";
export {
  captureOutput,
  expectNoWrites,
  runCommand,
  runExpectError
} from "./run.js";
export type { CapturedOutput } from "./run.js";
export {
  cleanupAll,
  trackDirectory,
  trackServer,
  useTempDirectory
} from "./lifecycle.js";
