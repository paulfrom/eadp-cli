from pathlib import Path


OUTPUT = Path(__file__).resolve().parent.parent / "docs" / "eadp-cli-request-flow.svg"
lines: list[str] = []


def add(value: str) -> None:
    lines.append(value)


def rect_node(
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    subtitle: str = "",
    fill: str = "#ffffff",
    stroke: str = "#d1d5db",
) -> None:
    add(f'  <g id="{node_id}" data-graph-role="node">')
    add(
        f'    <rect x="{x}" y="{y}" width="{width}" height="{height}" rx="10" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>'
    )
    title_y = y + (31 if subtitle else height // 2 + 5)
    add(
        f'    <text x="{x + width / 2}" y="{title_y}" text-anchor="middle" '
        f'class="node-title">{title}</text>'
    )
    if subtitle:
        add(
            f'    <text x="{x + width / 2}" y="{y + 52}" text-anchor="middle" '
            f'class="node-subtitle">{subtitle}</text>'
        )
    add("  </g>")


def diamond(
    node_id: str,
    cx: int,
    cy: int,
    half_width: int,
    half_height: int,
    title: str,
) -> None:
    points = (
        f"{cx},{cy - half_height} {cx + half_width},{cy} "
        f"{cx},{cy + half_height} {cx - half_width},{cy}"
    )
    add(f'  <g id="{node_id}" data-graph-role="node">')
    add(
        f'    <polygon points="{points}" fill="#fff7ed" stroke="#f59e0b" '
        f'stroke-width="1.8"/>'
    )
    add(
        f'    <text x="{cx}" y="{cy + 5}" text-anchor="middle" '
        f'class="node-title">{title}</text>'
    )
    add("  </g>")


def arrow(
    edge_id: str,
    path: str,
    color: str = "#2563eb",
    marker: str = "arrow-blue",
    label: str = "",
    label_x: int = 0,
    label_y: int = 0,
    dashed: bool = False,
) -> None:
    dash = ' stroke-dasharray="6,4"' if dashed else ""
    add(
        f'  <path id="{edge_id}" data-graph-role="edge" d="{path}" fill="none" '
        f'stroke="{color}" stroke-width="2"{dash} marker-end="url(#{marker})"/>'
    )
    if label:
        text_width = max(38, len(label) * 14 + 12)
        add(
            f'  <rect x="{label_x - text_width / 2}" y="{label_y - 15}" '
            f'width="{text_width}" height="22" rx="5" fill="#ffffff" opacity="0.96"/>'
        )
        add(
            f'  <text x="{label_x}" y="{label_y}" text-anchor="middle" '
            f'class="edge-label" fill="{color}">{label}</text>'
        )


add('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 1320" width="1120" height="1320">')
add("  <style>")
add(
    "    text { font-family: 'Microsoft YaHei', 'PingFang SC', "
    "'Helvetica Neue', Arial, sans-serif; }"
)
add("    .title { font-size: 26px; font-weight: 700; fill: #111827; }")
add("    .subtitle { font-size: 14px; fill: #6b7280; }")
add("    .lane-title { font-size: 13px; font-weight: 700; fill: #4b5563; letter-spacing: 0.08em; }")
add("    .node-title { font-size: 15px; font-weight: 600; fill: #111827; }")
add("    .node-subtitle { font-size: 12px; fill: #6b7280; }")
add("    .edge-label { font-size: 12px; font-weight: 600; }")
add("    .note { font-size: 12px; fill: #4b5563; }")
add("  </style>")
add("  <defs>")
add('    <marker id="arrow-blue" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">')
add('      <path d="M0,0 L10,4 L0,8 Z" fill="#2563eb"/>')
add("    </marker>")
add('    <marker id="arrow-green" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">')
add('      <path d="M0,0 L10,4 L0,8 Z" fill="#16a34a"/>')
add("    </marker>")
add('    <marker id="arrow-red" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">')
add('      <path d="M0,0 L10,4 L0,8 Z" fill="#dc2626"/>')
add("    </marker>")
add("  </defs>")
add('  <rect width="1120" height="1320" fill="#ffffff"/>')
add('  <text x="560" y="46" text-anchor="middle" class="title">EADP CLI 环境与请求流程</text>')
add(
    '  <text x="560" y="72" text-anchor="middle" class="subtitle">'
    "每个环境名称直接绑定一个 URL 和一个 Token，可设置一个默认环境</text>"
)

add('  <rect x="60" y="100" width="1000" height="150" rx="12" fill="#eff6ff" fill-opacity="0.58" stroke="#bfdbfe" stroke-dasharray="7,5"/>')
add('  <text x="82" y="125" class="lane-title">输入与环境解析</text>')
add('  <rect x="60" y="275" width="1000" height="345" rx="12" fill="#fff7ed" fill-opacity="0.42" stroke="#fed7aa" stroke-dasharray="7,5"/>')
add('  <text x="82" y="300" class="lane-title">环境与 TOKEN 解析</text>')
add('  <rect x="60" y="645" width="1000" height="570" rx="12" fill="#f0fdf4" fill-opacity="0.46" stroke="#bbf7d0" stroke-dasharray="7,5"/>')
add('  <text x="82" y="670" class="lane-title">校验、请求与输出</text>')

rect_node("command", 110, 145, 220, 70, "用户执行命令", "api call / request / skill", "#ffffff", "#93c5fd")
rect_node("environment", 450, 145, 220, 70, "解析目标环境", "--env 优先，否则 currentEnvironment", "#ffffff", "#93c5fd")
rect_node("load-config", 790, 145, 220, 70, "读取环境配置", "环境名称、baseUrl、token", "#ffffff", "#93c5fd")

rect_node("environment-priority", 170, 335, 360, 115, "选择目标环境", "1. --env 指定  2. 默认环境", "#ffffff", "#fdba74")
diamond("environment-found", 720, 392, 125, 62, "环境配置有效？")
rect_node("environment-error", 855, 510, 170, 72, "停止执行", "列出可用环境并返回非零状态", "#fef2f2", "#fca5a5")
rect_node("resolve-token", 170, 510, 360, 72, "解析环境 Token", "支持直接值或 ${ENV_VAR} 引用", "#ffffff", "#fdba74")
diamond("token-found", 720, 546, 125, 62, "Token 可用？")

rect_node("validate-input", 120, 700, 280, 78, "校验接口与请求参数", "Zod 校验定义，Ajv 校验 Body", "#ffffff", "#86efac")
diamond("high-risk", 590, 739, 120, 62, "高风险操作？")
rect_node("confirm", 790, 700, 230, 78, "确认或 Dry Run", "写入、删除、发布必须确认", "#ffffff", "#86efac")
rect_node("build-request", 450, 845, 280, 86, "组装 HTTP 请求", "baseUrl + path；注入 x-api-token", "#ffffff", "#86efac")
rect_node("send-request", 790, 845, 250, 86, "发送请求", "fetch + 超时 + JSON 解析", "#ffffff", "#86efac")
diamond("success", 590, 1010, 125, 65, "HTTP 与业务成功？")
rect_node("success-output", 300, 1125, 250, 72, "格式化成功结果", "人类可读或 --json；退出码 0", "#f0fdf4", "#86efac")
rect_node("failure-output", 760, 1125, 250, 72, "格式化错误结果", "Token 脱敏；返回非零退出码", "#fef2f2", "#fca5a5")

arrow("e1", "M330 180 H450")
arrow("e2", "M670 180 H790")
arrow("e3", "M900 215 V260 H350 V335")
arrow("e4", "M530 392 H595", label="目标环境", label_x=562, label_y=380)
arrow("e5", "M720 454 V484 H350 V510", color="#16a34a", marker="arrow-green", label="是", label_x=746, label_y=474)
arrow("e6", "M845 392 H940 V510", color="#dc2626", marker="arrow-red", label="否", label_x=882, label_y=380)
arrow("e7", "M530 546 H595")
arrow("e8", "M720 608 V660 H260 V700", color="#16a34a", marker="arrow-green", label="是", label_x=746, label_y=630)
arrow("e9", "M845 546 H855", color="#dc2626", marker="arrow-red", label="否", label_x=850, label_y=532)
arrow("e10", "M400 739 H470")
arrow("e11", "M710 739 H790", color="#16a34a", marker="arrow-green", label="是", label_x=750, label_y=727)
arrow("e12", "M590 801 V845", label="否", label_x=616, label_y=828)
arrow("e13", "M905 778 V820 H670 V845", color="#16a34a", marker="arrow-green", label="已确认", label_x=930, label_y=811)
arrow("e14", "M730 888 H790")
arrow("e15", "M915 931 V945 H590", label="响应", label_x=752, label_y=934)
arrow("e16", "M465 1010 H425 V1125", color="#16a34a", marker="arrow-green", label="是", label_x=448, label_y=998)
arrow("e17", "M715 1010 H885 V1125", color="#dc2626", marker="arrow-red", label="否", label_x=748, label_y=998)

add('  <g transform="translate(72,1260)">')
add('    <text x="0" y="0" class="note" font-weight="700">图例</text>')
add('    <line x1="48" y1="-5" x2="88" y2="-5" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow-blue)"/>')
add('    <text x="98" y="0" class="note">主流程</text>')
add('    <line x1="180" y1="-5" x2="220" y2="-5" stroke="#16a34a" stroke-width="2" marker-end="url(#arrow-green)"/>')
add('    <text x="230" y="0" class="note">有效 / 成功分支</text>')
add('    <line x1="370" y1="-5" x2="410" y2="-5" stroke="#dc2626" stroke-width="2" marker-end="url(#arrow-red)"/>')
add('    <text x="420" y="0" class="note">失败分支</text>')
add("  </g>")
add(
    '  <text x="1048" y="1295" text-anchor="end" class="note">'
    "同一 URL 的不同 Token 使用不同环境名称区分</text>"
)
add("</svg>")

OUTPUT.write_text("\n".join(lines), encoding="utf-8")
print(OUTPUT)
