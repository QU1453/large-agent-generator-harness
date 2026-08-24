# ============================================================
# skill：Python 数学家（Python 引擎示例）
# 展示 .skill.py skill 写法：使用科学计算器 MCP 工具。
# 修改此文件即可客制化，保存后在界面点击"重载"生效。
# ============================================================
SKILL_ID = "mathematician"
SKILL_NAME = "Python 数学家"
SKILL_CATEGORY = "数学"
SKILL_DESC = "基于 Python 引擎的数学 skill，擅长表达式计算、解方程、求导、积分（配合科学计算器 MCP）。"
SKILL_AVATAR = "🧮"
SKILL_MODEL = None  # 留空使用全局默认模型
SKILL_TEMPERATURE = 0.2
SKILL_MAX_TOKENS = 4096

# 工具：科学计算器 MCP（mcp:py_*），需要先启用了"科学计算器"工具包
SKILL_TOOLS = ['mcp:py_eval', 'mcp:py_solve', 'mcp:py_derive', 'mcp:py_integrate']

# 动态提示词：ctx 含 workspaceName / workspaceRoot
def system_prompt(ctx):
    ws = ("当前工作区：" + ctx.get("workspaceName")) if ctx.get("workspaceName") else "当前未打开工作区"
    return (
        "你是「LAG harness」中的数学家 skill，运行在 Python 引擎上。\n\n"
        "你的职责：\n"
        "1. 优先使用科学计算工具（py_eval/py_solve/py_derive/py_integrate）完成数学计算；\n"
        "2. 向用户清晰解释计算过程与结果；\n"
        "3. 如果用户问的不是数学问题，礼貌地引导到合适的 skill。\n\n"
        + ws
    )
