# ============================================================
# MCP: 科学计算器 (Python 引擎)
# 示例：展示 .py 工具包写法。需要 Python 环境（推荐安装 sympy）。
# 修改此文件即可客制化，保存后在界面点击"重载"生效。
# ============================================================
MCP_ID = "scientific"
MCP_NAME = "科学计算器"
MCP_DESC = "基于 Python 的科学计算工具：表达式求值、解方程、求导、积分。"

try:
    import sympy as sp
    HAS_SYMPY = True
except Exception:
    HAS_SYMPY = False
    import math

# 工具 schema：name / description / parameters(JSON Schema) / handler(函数名)
TOOLS = [
    {
        "name": "py_eval",
        "description": "计算数学表达式，支持 + - * / ^ 括号，以及 sin/cos/tan/log/sqrt/abs 等函数。例如 'sin(30) + 2^3'。",
        "parameters": {
            "type": "object",
            "properties": {
                "expr": {"type": "string", "description": "数学表达式"}
            },
            "required": ["expr"]
        },
        "handler": "py_eval"
    },
    {
        "name": "py_solve",
        "description": "解方程（需 sympy）。例如 'x**2 - 4'（解 x²-4=0）或 'x + y - 5, x - y - 1'（联立方程组）。",
        "parameters": {
            "type": "object",
            "properties": {
                "equation": {"type": "string", "description": "一个或多个方程（逗号分隔），形如 'x**2 - 4'"}
            },
            "required": ["equation"]
        },
        "handler": "py_solve"
    },
    {
        "name": "py_derive",
        "description": "求导（需 sympy）。例如 'x**3 + 2*x' 对 x 求导。",
        "parameters": {
            "type": "object",
            "properties": {
                "expr": {"type": "string", "description": "函数表达式"},
                "var": {"type": "string", "description": "求导变量，默认 x"}
            },
            "required": ["expr"]
        },
        "handler": "py_derive"
    },
    {
        "name": "py_integrate",
        "description": "求积分（需 sympy）。例如 'x**2' 对 x 积分；可带上下限 'x, 0, 2'。",
        "parameters": {
            "type": "object",
            "properties": {
                "expr": {"type": "string", "description": "被积表达式"},
                "limits": {"type": "string", "description": "可选定积分区间，如 '0, 2'"}
            },
            "required": ["expr"]
        },
        "handler": "py_integrate"
    }
]

# ---------------- handlers ----------------

def py_eval(args):
    expr = str(args.get("expr", "")).strip()
    if not expr:
        raise ValueError("缺少 expr 参数")
    if HAS_SYMPY:
        try:
            x = sp.symbols("x")
            value = sp.sympify(expr).subs({sp.pi: sp.N(sp.pi), sp.E: sp.N(sp.E)})
            return "= %s ≈ %s" % (sp.sstr(value), sp.N(value, 12))
        except Exception:
            pass
    # 标准库回退：仅支持基础四则与常见函数
    expr = expr.replace("^", "**")
    ns = {"sin": math.sin, "cos": math.cos, "tan": math.tan, "log": math.log,
          "sqrt": math.sqrt, "abs": abs, "pi": math.pi, "e": math.e}
    try:
        result = eval(expr, {"__builtins__": {}}, ns)  # noqa: S307
        return "= %s" % result
    except Exception as e:
        raise ValueError("无法计算该表达式（安装 sympy 可支持更多）：%s" % e)

def py_solve(args):
    if not HAS_SYMPY:
        raise ValueError("解方程需要 sympy，请执行: pip install sympy")
    eq = str(args.get("equation", "")).strip()
    if not eq:
        raise ValueError("缺少 equation 参数")
    x, y = sp.symbols("x y")
    exprs = [sp.sympify(e.strip()) for e in eq.split(",") if e.strip()]
    if len(exprs) == 1:
        solution = sp.solve(exprs[0], x)
    else:
        solution = sp.solve(exprs, [x, y], dict=True)
    return "解: %s" % sp.sstr(solution)

def py_derive(args):
    if not HAS_SYMPY:
        raise ValueError("求导需要 sympy，请执行: pip install sympy")
    expr = str(args.get("expr", "")).strip()
    var = str(args.get("var", "x")).strip() or "x"
    if not expr:
        raise ValueError("缺少 expr 参数")
    x = sp.symbols(var)
    result = sp.diff(sp.sympify(expr), x)
    return "d/d%s = %s" % (var, sp.sstr(result))

def py_integrate(args):
    if not HAS_SYMPY:
        raise ValueError("求积分需要 sympy，请执行: pip install sympy")
    expr = str(args.get("expr", "")).strip()
    if not expr:
        raise ValueError("缺少 expr 参数")
    x = sp.symbols("x")
    if args.get("limits"):
        lo, hi = [sp.sympify(v.strip()) for v in str(args["limits"]).split(",")[:2]]
        result = sp.integrate(sp.sympify(expr), (x, lo, hi))
    else:
        result = sp.integrate(sp.sympify(expr), x)
    return "∫ = %s" % sp.sstr(result)
