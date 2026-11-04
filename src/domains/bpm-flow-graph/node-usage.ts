/**
 * Business-oriented node selection guidance shipped with the CLI.
 *
 * This data helps an agent choose a node from confirmed business semantics.
 * It is not evidence that a target environment supports a referenced page,
 * interface, position or subprocess; those dependencies still require lookup.
 */
export interface NodeUsageGuidance {
  summary: string;
  exampleScenarios: readonly string[];
  notFor: readonly string[];
  requiredInputs: readonly string[];
  askWhenUnclear: readonly string[];
}

export const NODE_USAGE: Readonly<Record<string, NodeUsageGuidance>> = {
  StartEvent: {
    summary: "流程的唯一入口，只表达流程启动，不承载审批或填写任务。",
    exampleScenarios: ["提交项目资料后启动审批", "发起合同申请后进入第一个审批环节"],
    notFor: ["需要发起人填写或修改内容的环节", "需要人工选择后续路径的环节"],
    requiredInputs: ["启动动作的业务含义", "启动后的第一个节点"],
    askWhenUnclear: ["提交前是否还需要一个人工填写/校验节点？"]
  },
  EndEvent: {
    summary: "正常完成流程；到达后不再产生后续任务。",
    exampleScenarios: ["全部必需审批通过后归档", "无需任何审批的资料正常结束"],
    notFor: ["驳回后还要修改重报", "需要立即终止所有并行分支的场景"],
    requiredInputs: ["正常完成条件", "结束前是否还有抄送、服务或子流程"],
    askWhenUnclear: ["这里是正常完成，还是要取消整个流程？"]
  },
  TerminateEndEvent: {
    summary: "明确终止流程；只有业务确认不再修改重报时才使用。",
    exampleScenarios: ["业务规则明确规定否决后关闭申请", "审批不通过即作废且必须重新发起新单据"],
    notFor: ["驳回后返回发起人修改", "仅结束当前一条分支"],
    requiredInputs: ["终止触发条件", "是否终止全部分支", "是否允许修改重报"],
    askWhenUnclear: ["不同意究竟是终止整张单据，还是退回修改后重走审批？"]
  },
  Normal: {
    summary: "由人完成普通办理动作，不表达同意/不同意的审批决策。",
    exampleScenarios: ["发起人修改单据", "资料管理员补充附件", "公文结束后由岗位办理抄送"],
    notFor: ["需要审批结果驱动两条路径", "多人按票数形成共同结论"],
    requiredInputs: ["办理动作", "执行人类型及业务键", "工作页面", "完成后的唯一下一节点"],
    askWhenUnclear: ["这一步只是办理/修改，还是需要作出审批决定？"]
  },
  SingleSign: {
    summary: "一人办理或确认且不产生审批双分支；不要仅因审批人只有一位就选择它。",
    exampleScenarios: ["负责人确认已知悉", "单人完成登记后进入下一环节"],
    notFor: ["存在同意与不同意两种业务结果", "多人会签或按金额决定审批路径"],
    requiredInputs: ["单人办理语义", "执行人", "工作页面", "唯一完成路径"],
    askWhenUnclear: ["该节点是否存在不同意/驳回结果？有则应评估 Approve。"]
  },
  Approve: {
    summary: "一个审批环节形成同意/不同意结果，必须用两条出口明确两种去向。",
    exampleScenarios: ["部门负责人审批", "金额达到阈值后增加总经理审批", "法务审核通过后进入下一环节"],
    notFor: ["仅修改、抄送或填写", "多人按通过比例共同决策", "由系统自动判断条件的分支"],
    requiredInputs: ["审批人及绑定类型", "工作页面", "同意去向", "不同意去向", "是否修改重报"],
    askWhenUnclear: ["审批人如何确定？", "不同意后终止、返回上一节点还是由发起人修改后从头重审？"]
  },
  CounterSign: {
    summary: "多人在同一审批环节参与，并按并行/串行及通过规则形成共同结果。",
    exampleScenarios: ["多个部门负责人共同会签", "业务中心多人全部同意后通过"],
    notFor: ["多个角色有明确先后审批顺序", "仅一人审批", "多个互不依赖的并行任务分支"],
    requiredInputs: ["参与人集合", "并行或串行", "通过比例/票数", "同意与不同意去向", "工作页面"],
    askWhenUnclear: ["是同一环节多人会签，还是多个审批环节依次执行？", "通过规则是全部、比例还是固定票数？"]
  },
  ParallelTask: {
    summary: "表达节点内的并行办理语义；只有业务明确需要该设计器能力时才使用。",
    exampleScenarios: ["同一办理环节允许多人并行处理但不按审批票数决策"],
    notFor: ["多人审批并形成通过率", "多条独立分支需要并行网关", "普通单人办理"],
    requiredInputs: ["并行办理的运行语义", "参与人", "工作页面", "完成条件"],
    askWhenUnclear: ["这里与 CounterSign、ParallelGateway 的区别是什么？无法确认时不要自行选择。"]
  },
  SerialTask: {
    summary: "表达节点内的串行办理语义；不要把可独立审批的多个角色默认塞进一个节点。",
    exampleScenarios: ["同一办理环节要求参与人按顺序依次处理"],
    notFor: ["需要分别展示和追踪多个审批阶段", "多人同时会签", "单人次办理"],
    requiredInputs: ["串行参与人及顺序", "工作页面", "整体完成条件"],
    askWhenUnclear: ["应使用一个 SerialTask，还是拆成多个有独立业务含义的 Approve 节点？"]
  },
  ServiceTask: {
    summary: "表达系统自动处理，不由人员领取办理。",
    exampleScenarios: ["审批结束后自动同步状态", "自动调用业务服务生成后续数据"],
    notFor: ["需要人员操作的办理", "等待外部系统稍后触发", "独立子流程"],
    requiredInputs: ["自动处理语义", "需要回调时的接口 URL 与同步/异步要求", "成功后的去向"],
    askWhenUnclear: ["系统调用失败应阻止流程、重试还是允许人工处理？该运行规则是否已明确？"]
  },
  ManualTask: {
    summary: "表达不依赖页面或执行人的占位/线下动作，不应用于掩盖未澄清的审批规则。",
    exampleScenarios: ["已有设计中的线下确认占位", "仅需在建模中标注人工准备动作"],
    notFor: ["真实审批或系统内办理", "节点类型尚未确认时临时占位后继续写入"],
    requiredInputs: ["线下动作含义", "为何不需要执行人和页面", "完成后的去向"],
    askWhenUnclear: ["这是有意保留的线下占位，还是尚未明确的业务节点？"]
  },
  ReceiveTask: {
    summary: "流程暂停并等待外部触发，收到规定事件后继续。",
    exampleScenarios: ["等待外部系统回执", "等待指定业务信号后进入下一环节"],
    notFor: ["立即执行的自动服务", "人员手动审批", "仅按表单字段分流"],
    requiredInputs: ["触发事件及服务接口", "等待语义", "触发后的去向"],
    askWhenUnclear: ["由什么事件恢复流程？", "是否需要超时或补偿规则？"]
  },
  AgentTask: {
    summary: "由智能体按指定模板完成任务，需要明确执行人、模板、超时及服务配置。",
    exampleScenarios: ["智能体生成审核摘要", "按受控模板完成自动分析"],
    notFor: ["普通规则计算", "无智能体模板的人工审批", "未明确超时和结果处理的自动任务"],
    requiredInputs: ["executorName", "agentTemplate", "outTime", "服务接口", "结果去向"],
    askWhenUnclear: ["智能体输出如何影响流程？", "模板、执行人和超时时间分别是什么？"]
  },
  PoolTask: {
    summary: "任务进入工作池，由符合池规则的成员领取办理。",
    exampleScenarios: ["共享客服池领取处理任务", "资料处理池按池代码分配工作"],
    notFor: ["固定岗位审批", "发起人本人修改", "无工作池代码的普通任务"],
    requiredInputs: ["poolTaskCode", "工作页面", "服务接口", "领取与完成语义"],
    askWhenUnclear: ["工作池代码及领取规则是什么？", "与 PositionType 动态选人有什么区别？"]
  },
  CallActivity: {
    summary: "调用具有独立生命周期的已发布子流程；当前文件导入/迁移通道会阻断该节点。",
    exampleScenarios: ["主流程进入独立维护的用章子流程", "调用跨流程复用的完整审批链"],
    notFor: ["主流程中的一个普通审批人", "可用单个服务调用完成的动作", "目标环境没有对应已发布子流程"],
    requiredInputs: ["子流程业务标识", "版本要求", "输入输出关系", "目标环境已发布证据"],
    askWhenUnclear: ["这是独立子流程还是主流程内环节？", "目标环境是否已有匹配的已发布版本？"]
  },
  ExclusiveGateway: {
    summary: "系统按字段条件自动选择一条路径；业务分流优先级最高的节点，条件字段能判定时必须优先用它。",
    exampleScenarios: [
      "按资料类型决定是否进入某审批",
      "金额达到阈值时增加审批，否则走默认路径",
      "多个可选审批角色按固定顺序逐级判断"
    ],
    notFor: [
      "由用户人工选择路径",
      "多条路径需要同时执行",
      "条件字段或默认值尚未明确",
      "系统条件字段无法判定、必须由人运行时选择"
    ],
    requiredInputs: [
      "条件变量及类型（取自 eadp bpm graph conditions 的清单）",
      "条件覆盖与优先级",
      "唯一默认路径",
      "每个条件命中的去向"
    ],
    askWhenUnclear: [
      "条件是否互斥且能穷尽？",
      "未命中任何条件时走哪里？",
      "金额边界是否包含等于？",
      "该判定字段是否已在系统提供的条件清单中？"
    ]
  },
  ManualExclusiveGateway: {
    summary: "由人在运行时选择一条后续路径，不用于系统自动字段判断；属于分流兜底，优先级最低。",
    exampleScenarios: ["提交人人工选择加签路径", "负责人根据线下情况选择后续办理方向"],
    notFor: [
      "按类型、金额或布尔字段自动分流",
      "多条路径并行",
      "未明确由谁选择",
      "系统条件字段已经可以判定该分流"
    ],
    requiredInputs: ["选择人及所在任务", "可选路径", "选择发生的时间与业务含义"],
    askWhenUnclear: [
      "路径由人选择还是系统按字段判断？",
      "选择动作配置在哪个前置人工节点？",
      "为什么系统排他网关无法判定该分流？"
    ]
  },
  ParallelGateway: {
    summary: "无条件同时进入多条独立路径，并按业务约定汇合。",
    exampleScenarios: ["财务审核与法务审核必须同时开展", "多个资料准备任务全部完成后汇合"],
    notFor: ["只选择一条路径", "多人同一审批环节会签", "按条件选择部分分支"],
    requiredInputs: ["全部分支", "是否必须全部执行", "汇合规则及去向"],
    askWhenUnclear: ["所有分支都必须完成吗？", "任一分支否决如何影响其他分支？"]
  },
  InclusiveGateway: {
    summary: "按条件执行一条或多条路径，并保留一条默认路径；优先级低于系统排他网关，只在可能同时命中多条时使用。",
    exampleScenarios: ["按申请内容同时触发财务与法务中的一条或多条审核路径"],
    notFor: ["严格只选一条路径", "无条件全部并行", "无法确定多分支汇合语义"],
    requiredInputs: ["可组合条件", "默认路径", "分支汇合与完成规则"],
    askWhenUnclear: ["是否可能同时命中多条？", "命中多条时应并行还是仍只走一条？"]
  },
  MailTask: {
    summary: "历史邮件节点，仅为既有流程迁移兼容保留。",
    exampleScenarios: ["旧流程已经包含 MailTask 且需要原样评估迁移"],
    notFor: ["新流程的默认通知方案", "目标环境能力未确认的新设计"],
    requiredInputs: ["历史节点行为", "目标环境兼容证据"],
    askWhenUnclear: ["是否应改用当前通知或服务节点？未确认前不要用于新图。"]
  },
  ScriptTask: {
    summary: "历史脚本节点，仅为既有流程迁移兼容保留。",
    exampleScenarios: ["旧流程已有脚本任务并需要评估兼容迁移"],
    notFor: ["新流程默认承载业务逻辑", "可用明确服务接口替代但尚未评估的场景"],
    requiredInputs: ["脚本行为", "安全与兼容要求", "目标环境支持证据"],
    askWhenUnclear: ["新设计是否应使用受支持的当前节点？"]
  },
  EventGateway: {
    summary: "历史事件网关，仅为既有流程迁移兼容保留。",
    exampleScenarios: ["旧流程按不同事件选择路径并需要评估迁移"],
    notFor: ["普通字段排他分支", "新流程的默认事件分流方案"],
    requiredInputs: ["等待的事件集合", "历史运行语义", "目标兼容证据"],
    askWhenUnclear: ["应保留历史语义还是改用当前支持的 ReceiveTask/网关组合？"]
  }
};

export function nodeUsageForKind(kind: string): NodeUsageGuidance {
  const usage = NODE_USAGE[kind];
  if (!usage) throw new Error(`节点 ${kind} 缺少使用场景指导`);
  return usage;
}
