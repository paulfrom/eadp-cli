/** Versioned, CLI-local best practices for designing a graph from business facts. */
export const BPM_GRAPH_GUIDE_VERSION = "2026-11-04";

export const BPM_GRAPH_GUIDE = {
  kind: "eadp.bpm.graph.guide.v1",
  guideVersion: BPM_GRAPH_GUIDE_VERSION,
  purpose: "把独立业务输入转换为可校验、可预览、可回查的规范化流程图；不依赖某个参考实现或输入文件格式。",
  inputPolicy: {
    acceptedEvidence: ["业务规则说明", "结构化表格", "既有设计稿", "页面与接口契约", "目标环境只读查询结果"],
    rules: [
      "输入格式不参与节点选择；只使用其中能够确认的业务事实。",
      "外部参考只能说明业务意图或配置范式，不能证明目标环境存在相同 ID、岗位、页面、接口或子流程。",
      "节点能力以 eadp bpm graph nodes 为准，目标绑定以只读查询为准，不得以历史示例替代。"
    ]
  },
  uncertaintyPolicy: {
    action: "ASK_USER",
    rule: "节点类型、执行人、条件、路径、驳回语义、页面、接口或子流程任何一项不能唯一确定时，先提出具体问题；不得猜测、静默套用模板或执行写入。",
    questions: [
      "这一步是普通办理、单人审批、多人会签、自动服务、等待触发，还是独立子流程？",
      "路径由系统按字段判断还是由人选择？可能走一条、多条还是全部路径？",
      "执行人按发起人、指定人员、固定岗位、岗位类别还是自定义接口确定？",
      "不同意后终止、返回上一环节，还是修改后重审？重审从头开始还是从驳回环节继续？",
      "条件使用哪个变量、什么数据类型、哪些允许值？空值和阈值等号如何处理？",
      "该判定变量是否已在系统提供的条件字段清单中？业务需要的字段系统没有发布怎么办？",
      "工作页面、接口 URL、子流程业务标识及目标环境版本是否已有明确证据？"
    ]
  },
  conditionSource: {
    rule: "网关条件只能使用目标环境业务实体发布的条件字段；先加载清单，再写条件。",
    command: "eadp bpm graph conditions --env <target> --flow <flow-code>",
    fields: [
      "code：表达式 groovyUel 使用的引擎变量，例如 #{fileType==\"销售-合同验收\"}",
      "name：中文条件 logicUel 使用的业务名称，例如 文件类型==\"销售-合同验收\"",
      "initValue：引擎校验表达式时使用的初始值",
      "remark：业务实体对该条件的说明"
    ],
    priority: {
      rule: "系统排他网关优先级最高：条件字段能判定的业务分流一律使用系统排他网关。",
      order: ["ExclusiveGateway（系统排他）", "InclusiveGateway（系统包容）", "ParallelGateway（并行）", "ManualExclusiveGateway（人工排他）"],
      fallback: "人工排他网关是兜底，不得在系统条件字段可以判定时使用。"
    },
    rules: [
      "不得自造变量名；条件变量必须来自 eadp bpm graph conditions 的输出。",
      "logicUel 与 groovyUel 必须表达同一条件：前者用条件名称，后者用条件 code。",
      "业务需要的判定字段系统没有发布时，先提出该字段缺失，不要用近似字段顶替。",
      "同一网关内不要混用系统判定与人工选路。"
    ]
  },
  workflow: [
    {
      step: "clarify-business",
      action: "整理业务步骤、先后关系、条件、执行人、每个结果的去向和结束后动作；输出待确认问题而不是猜图。"
    },
    {
      step: "load-conditions",
      command: "eadp bpm graph conditions --env <target> --flow <flow-code>",
      action: "取回目标环境业务实体发布的系统判定条件字段（code/name/initValue）；所有网关条件只能使用其中的变量，缺失字段先提出问题。"
    },
    {
      step: "select-nodes",
      command: "eadp bpm graph nodes",
      action: "逐节点核对 exampleScenarios、notFor、requiredInputs、askWhenUnclear，再确定 kind；分流优先使用系统排他网关。"
    },
    {
      step: "prepare-skeleton",
      action: "确认目标流程类型、业务实体、页面和接口骨架已存在；缺失时先走 bpm configure 或 resource sync bpm，不得直接写图。"
    },
    {
      step: "resolve-bindings",
      action: "用目标环境只读查询把人员/岗位/岗位类别/组织解析为业务 code，把页面/接口解析为 URL；零个或多个候选都必须停下来澄清。"
    },
    {
      step: "build-canonical-file",
      action: "生成 kind=eadp.bpm.graph.v1 的规范化图文件，不直接构造设计器原始 defJson，不复制任何外部环境 ID。"
    },
    {
      step: "review-business-paths",
      action: "在远端写入前，用代表性业务输入核对预期路径、默认路径、驳回重审范围及阈值边界。"
    },
    {
      step: "validate",
      command: "eadp bpm graph validate --env <target> --file <graph.json> --strict",
      action: "要求 valid=true 且 designValid=true；designValid 只代表结构可保存，不代表业务正确。"
    },
    {
      step: "preview-import",
      command: "eadp bpm graph import --env <target> --flow <flow-code> --file <graph.json> --strict",
      action: "核对目标定义、create/update/blocked、缺失依赖和变更范围；不得把意外 create 当作安全结果。"
    },
    {
      step: "apply-verify",
      command: "eadp bpm graph import --env <target> --flow <flow-code> --file <graph.json> --strict --apply",
      action: "仅在用户确认预览后执行；要求 verified=true，并再次预览确认 unchanged。草稿由人在设计器复核并发布。"
    }
  ],
  selectionPatterns: [
    {
      name: "业务分流首选系统排他网关",
      useWhen: "任何需要按业务条件选择后续路径的场景。",
      nodeKinds: ["ExclusiveGateway"],
      rules: [
        "系统排他网关优先级最高：先确认能否用系统条件字段判定，能判定就用它",
        "条件变量必须来自 eadp bpm graph conditions 输出的清单",
        "每个网关恰好一条默认边，未命中路径必须可解释",
        "只有系统条件字段无法判定、必须由人选择时才降级到人工排他网关",
        "人工排他网关属于兜底，不得当作默认选型"
      ]
    },
    {
      name: "单个审批决策",
      useWhen: "一个环节产生同意和不同意两种结果。",
      nodeKinds: ["Approve"],
      rules: ["恰好两条出口", "恰好一条 uel.agree=true", "两种结果的业务去向都必须明确"]
    },
    {
      name: "普通办理或修改",
      useWhen: "人员只完成填写、修改、抄送等动作，不形成审批双分支。",
      nodeKinds: ["Normal"],
      rules: ["需要执行人和工作页面", "发起人本人办理时使用 StartUser", "不要用 Normal 冒充审批"]
    },
    {
      name: "固定互斥完整路线",
      useWhen: "一种业务输入只对应一条完整审批路线，路线之间不叠加。",
      nodeKinds: ["ExclusiveGateway", "Approve"],
      rules: ["可使用一个系统排他网关连接多个条件分支", "必须有默认路线", "先证明条件互斥且覆盖完整"]
    },
    {
      name: "按顺序叠加的可选审批角色",
      useWhen: "多个角色有固定先后顺序，每个角色可独立按条件参加，命中条件可能叠加。",
      nodeKinds: ["ExclusiveGateway", "Approve"],
      rules: [
        "每个可选环节用一个系统排他网关判断是否参加",
        "条件命中进入审批，审批同意及未命中默认边都连接到下一个判断",
        "不要把相互可叠加的角色误画成一个人工排他网关的固定多路线"
      ]
    },
    {
      name: "多人共同审批",
      useWhen: "多人在同一环节按通过规则形成共同结论。",
      nodeKinds: ["CounterSign"],
      rules: ["确认并行/串行与通过比例", "恰好两条出口且一条同意边", "多个角色有先后顺序时改用多个 Approve"]
    },
    {
      name: "修改并重审",
      useWhen: "审批不同意后允许发起人修改并再次提交。",
      nodeKinds: ["Approve", "Normal", "ExclusiveGateway"],
      rules: [
        "不同意边进入明确的修改节点，修改节点通常使用 StartUser",
        "重审入口必须由业务确认：从头重审或回到指定环节",
        "不得未经确认改用 TerminateEndEvent"
      ]
    },
    {
      name: "系统选择或人工选择",
      useWhen: "需要排他分支时先区分选择主体。",
      nodeKinds: ["ExclusiveGateway", "ManualExclusiveGateway"],
      rules: ["字段自动判断使用系统排他", "用户运行时选路使用人工排他", "系统排他必须有默认边，人工排他不强制默认边"]
    },
    {
      name: "多路径并行或条件并行",
      useWhen: "多个独立分支需要同时或按组合条件执行。",
      nodeKinds: ["ParallelGateway", "InclusiveGateway"],
      rules: ["全部无条件执行使用 ParallelGateway", "可命中一条或多条使用 InclusiveGateway", "先确认汇合、否决及终止语义"]
    },
    {
      name: "结束后的自动或人工后处理",
      useWhen: "审批完成后还有同步、签章、抄送或独立子流程。",
      nodeKinds: ["ServiceTask", "Normal", "CallActivity"],
      rules: [
        "系统自动动作使用 ServiceTask 或流程级事件，人工办理使用 Normal",
        "只有独立生命周期的已发布流程才使用 CallActivity",
        "CallActivity 当前会被导入/迁移通道阻断，不得静默替换成其他节点"
      ]
    }
  ],
  executorSelection: [
    { type: "StartUser", useWhen: "由流程发起人本人修改或办理。", binding: "无需人员 code" },
    { type: "Person", useWhen: "明确指定一个员工。", binding: "employee code" },
    { type: "Position", useWhen: "明确指定具体岗位实例。", binding: "position code，并核对组织上下文" },
    { type: "PositionType", useWhen: "按岗位类别动态确定人员。", binding: "position category code" },
    { type: "SelfDefinition", useWhen: "由自定义选人接口返回执行人。", binding: "interface URL；接口类型 CUSTOM_PERSON" },
    { type: "PositionTypeAndOrg", useWhen: "岗位类别还必须受组织范围约束。", binding: "PositionType 与 Org 两个分片缺一不可" },
    { type: "AnyOne", useWhen: "业务明确允许任意执行人且存在维度限制。", binding: "先确认维度限制，不得当作未确定执行人的兜底" }
  ],
  conditionContract: {
    required: ["中文业务含义", "引擎变量名", "数据类型", "允许值/枚举", "空值语义", "比较符及阈值是否含等号"],
    rules: [
      "条件变量名必须来自 eadp bpm graph conditions 的清单，不得从中文标题或历史示例猜测。",
      "logicUel 与 groovyUel 必须表达同一业务条件：logicUel 用条件名称，groovyUel 用条件 code。",
      "系统排他网关每个网关恰好一条默认边；未命中路径必须可解释。",
      "连线标题不是机器条件；标题与实际表达式冲突时先澄清。",
      "多个条件可叠加时不得按固定互斥路线处理。",
      "系统提供的条件字段无法表达业务规则时，先提出字段缺失，不要用近似字段顶替。"
    ]
  },
  edgeContract: [
    "Approve/CounterSign 恰好两条出口，一条同意边 uel.agree=true；另一条的驳回去向必须明确。",
    "ExclusiveGateway/InclusiveGateway 恰好一条 uel.isDefault=true；ManualExclusiveGateway 不强制默认边。",
    "StartEvent 恰好一个且至少一条出口；每个普通节点有出入口；EndEvent 至少一个且没有出口。",
    "节点显示名不是执行人绑定依据；执行人必须读取并确认 executor 配置。"
  ],
  acceptance: [
    "为每种代表性业务输入列出预期经过节点和跳过节点，并与生成图逐条核对。",
    "覆盖条件为空、未命中默认值、阈值以下/等于/以上，以及多个条件同时成立的情况。",
    "覆盖同意、不同意、修改后重审、会签、并行汇合及结束后动作。",
    "逐条核对网关条件变量都在 eadp bpm graph conditions 的清单内；缺失字段已提出并得到答复。",
    "strict validate 同时满足 valid/designValid；所有 missingDependencies 已解决。",
    "import 预览没有意外 create 或 blocked；apply 后 verified=true，再次预览为 unchanged。",
    "设计器复核草稿和布局后再人工发布；CLI 不自动发布。"
  ],
  prohibitions: [
    "不得因信息不全而自行选择节点、执行人、条件或驳回路径。",
    "不得复制外部环境的定义、版本、组织、页面、接口、岗位或子流程 ID。",
    "不得把原始 defJson 当作可移植文件，不得绕过规范化文件通道直接写图。",
    "不得把 designValid=true 当作业务规则已验证。",
    "不得用 ManualTask、AnyOne 或默认路径掩盖未澄清需求。",
    "不得自动移除 CallActivity、ProjectPosition、智能审核等 blocked 内容后继续写入。",
    "不得自造条件变量名，也不得在没有加载系统条件清单时设计网关条件。",
    "不得在系统条件字段可以判定时使用人工排他网关。"
  ]
} as const;
