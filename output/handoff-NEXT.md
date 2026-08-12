# EADP CLI Cloud Fabric 架构图 — Handoff

## 当前会话已完成（可在现有基础上继续）
为 `D:\project\ead\eadp cli` 生成了 Cloud Fabric（Style 10）风格架构图。产出文件：
- `output/eadp-cloud-fabric.svg`（1400×1640）
- `output/eadp-cloud-fabric.png`（2800×3280 @2x）
- `output/eadp-diagram.json`（渲染输入配置，UTF-8）
- `output/eadp-layout.json`（布局报告，ok:true，仅 11 条 info 级交叉桥接）
- **构建脚本（唯一事实来源）**：`C:\Users\lin\AppData\Local\Temp\build_eadp_diagram.py`
  —— 改配置只改这个脚本再重跑，永远不要手工改 JSON。

## 渲染管线（照此操作）
1. 编辑 builder → `python C:/Users/lin/AppData/Local/Temp/build_eadp_diagram.py` → 生成 `output/eadp-diagram.json`
2. 渲染：
   `cd C:/Users/lin/.claude/skills/fireworks-tech-graph && PYTHONUTF8=1 python scripts/generate-from-template.py architecture "D:/project/ead/eadp cli/output/eadp-cloud-fabric.svg" --layout-report "D:/project/ead/eadp cli/output/eadp-layout.json" < "D:/project/ead/eadp cli/output/eadp-diagram.json"`
3. 校验：`python scripts/validate_svg.py <svg> --check xml|markers|collisions|geometry|composition`（每个退出码 0）
4. PNG：`cd /tmp/fireworks-png && NODE_PATH=/tmp/fireworks-png/node_modules node "C:/Users/lin/AppData/Local/Temp/render_svg_png.js" <svg> <png>`（用已装的 Chrome）

## 关键约束（血的教训，违反即硬失败）
- **cloud-fabric 语义契约**（generate-from-template.py 会硬校验，无跳过）：
  - `diagram_type` 必须为 `"deployment"`
  - `platform_profile` ∈ {provider-neutral, aws, azure, gcp, kubernetes}
  - `icon_manifest_version` 必须为 `"2026.07-neutral.1"`；icon 清单只有 6 个：`generic:traffic / gateway / compute / database / stream / observability`
  - **每个节点**必须有 `deployment_id`（指向某个 container）和 `icon_id`；节点必须在所属 container 内部 ≥20px
  - 兄弟 container 之间 ≥16px 间距；子 container 在父内部 ≥16px；嵌套深度 ≤4
  - 跨 deployment 的边必须有非空 `via`
- **quality_profile 用映射覆盖**（密集图超过 showcase 默认值）：
  `"quality_profile": {"profile":"showcase","max_bends_per_edge":12,"max_total_bends":120,"max_route_stretch":4.0,"max_bridged_crossings":30,"min_segment_length":0}`
- **节点间距 ≥80px**：路由默认 routing_padding=24，需要 ≥48px 通道；列距 35px/60px 都会导致 "no collision-free route"
- 困难长斜线箭头可单独设 `routing_padding:14`（如 bpm→discovery）
- **Style 10 规则**：箭头无 `label` 但有 `via` 时，`via` 会当作 label 渲染。同 deployment 的边不需要 via（可完全无标签）；跨 deployment 无标签边的 via 会变成短标签（用 2-4 字，如 "源码"/"客户端"）
- **中文必须 `PYTHONUTF8=1`**：stdin 管道在 Windows 下编码错误会乱码
- `validate-svg.sh` 用 `python3`（Windows Store 占位 stub，坏）→ 直接用 `python` 调 `validate_svg.py`
- cairosvg 缺原生 cairo DLL → 用 puppeteer-core + 已装 Chrome 渲染 PNG
- **路由顺序敏感**：箭头按数组顺序路由，先路由的箭头其路线+标签成为后者的障碍；困难的箭头放数组前面

## 当前图结构（将要被下一版重排）
- 使用入口：终端用户 + AI 助手
- 命令入口层：cli.ts / commands/verbs.ts / runtime-options.ts
- 命令注册器层(8)：env / resource / api / bpm / permission / rollback / skill / update
- 领域服务层(4)：resource/client、permission/client、bpm/client、menu/service
- BPM/目录支持层(4)：bpm/discovery、bpm/configure、bpm/sync、catalog/loader
- 核心基础设施层(7)：config/store、config/resolve、http/client、http/pagination、io、errors、tenant
- 操作记录层(3)：operations/recorder、operations/store、operations/rollback
- EADP 远端环境：api-gateway → sei-basic、sei-bpm
- 箭头 21 条：编号数据流 ①-⑨（查询场景）、响应/输出、写/回滚、4 条依赖

## 源码事实（供下一版命名与职责使用）
- cli.ts：`createProgram()`/`main()`，组装 commander 命令树、解析 argv、统一错误出口
- commands/verbs.ts：8 个动词组 inspect/query/call/apply/assign/revoke/sync/verify
- resource.ts（大而全）：imports BpmClient、syncBpmFlow、resolveEnvironment、ConfigStore、io、menu/service、OperationRecorder/Store、resource/client、runtime-options、tenant、verbs
- permission.ts：imports PermissionClient、tenant、operations、project/name、io、config
- bpm.ts：imports BpmClient、configureBpmProject、discovery(discoverBpmProject/selectBpmFlow)、tenant、operations
- api.ts：imports catalog(loadCatalog/findEndpoint)、http/client 的 sendRequest/buildUrl（**直接调用 http，绕过领域客户端**）、io、tenant
- 领域客户端：ResourceClient（通用 findByPage/findAll/save/getTree/move）；PermissionClient（sei-basic 权限/角色/菜单/用户/授权）；BpmClient（sei-bpm）；menu/service.ts（委托 **ResourceClient**，不是 PermissionClient）
- 支持层：bpm/discovery.ts（从源码发现流程骨架）；bpm/configure.ts（幂等组装基础配置）；bpm/sync.ts（用 BpmClient+OperationRecorder）；catalog/loader.ts（接口目录加载/端点查找）
- 核心层：config/store.ts（ConfigStore 读写 ~/.eadp-cli/config.yaml）；config/resolve.ts（环境→URL/Token/tenantCode）；http/client.ts（sendRequest，x-api-token，信封校验）；http/pagination.ts（iteratePages 分页）；io.ts（printValue JSON / printJsonLine NDJSON 流式）；errors.ts（CliError）；tenant.ts（租户隔离 global/非 global）
- 操作层：operations/recorder.ts（operationId、recordAction、complete 返回 operationId）；operations/store.ts（30 天日志）；operations/rollback.ts（回查比对、逆序撤销）
- 远端：api-gateway；sei-basic（权限/资源/菜单/用户/给号）；sei-bpm（BPM 流程/类型/集成接口）
- 完整命令与流程文档见项目根 README.md（中文）

## 下一版需求（用户明确要求，必须照做）
1. **去掉终端用户，只保留 AI 助手入口**（AI/eadp-operator Skill）
2. **不用 .ts 文件名展示**，用实际中文含义命名模块（如 "配置解析" 而非 config/resolve.ts）
3. **命令注册层做薄**（合并/简化命令，不要 8 个逐个展开那么厚）
4. **去掉源码发现部分**（bpm/discovery.ts 不画）
5. **领域服务明确"管理目标 + 核心能力"**（每个领域服务写清楚管什么、能做什么）
6. **去掉目录支持层**（catalog/loader.ts 不画）
7. **核心集成设施按方块排列，并加入操作回放（rollback）**
8. **操作记录放最右边、竖排**，表示对整个流程的监控（竖列横跨各层）
9. **EADP 运行环境用包含结构**：gateway 在上，微服务在下（containment：外层运行时环境，内层 gateway 包微服务）
10. **加入后续产品可对接进入的能力**（扩展点/对接入口，画出来）

## 建议技能（下一会话务必先调用）
- `fireworks-tech-graph`：绘图核心技能（Style 10 Cloud Fabric），必须先加载
- 若对源码结构拿不准，用 `codebase-memory` 查 eadp-cli 的架构图/调用关系（已索引，project 名 "eadp-cli"）
- 用户全局 CLAUDE.md 强调：开工前明确成功标准；有疑问先问；token 预算有限（单任务 4k，会话 30k）
