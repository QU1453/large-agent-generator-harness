# ============================================================
# MCP: PID 调参记忆管理
# 电机 PID 调参 Agent 的三层记忆系统：
#   短期记忆  —— 本次调参会话：目标 + 当前参数 + 最近 N 轮迭代（滑动窗口）
#   长期记忆  —— 经验库（SQLite）：成功/失败经验，记录 目的-方案-结果-痛点，带标签
#   程序性记忆—— 宏指令（SQLite）：从成功经验提炼的一键宏，对经验库的操作
# 记忆维护  —— 滑动窗口：到达存储上限自动去重合并同类踩坑；有新解法直接覆盖旧解法
# 存储位置  —— <AI_HARNESS_DATA 或 D:/Project/Harness/data>/pid-memory/
#             lessons.db（经验+宏） + session.json（短期会话，只追加保留最近 N 轮）
# 保存后到「工具/MCP」页点重载生效，画布上可被 PID 调参 Agent 调用。
# ============================================================

MCP_ID = "pid_memory"
MCP_NAME = "PID 调参记忆"
MCP_DESC = "电机 PID 调参的三层记忆管理：短期会话（目标+当前参数，滑动窗口）、长期经验库（成功/失败，目的-方案-结果-痛点+标签，SQLite）、程序性宏指令（从成功经验提炼）；容量达上限自动去重合并同类踩坑、新解法覆盖旧解法。"

import os
import json
import time
import sqlite3
from datetime import datetime

# ---------------- 存储位置 ----------------
def _data_root():
    env = os.environ.get("AI_HARNESS_DATA", "").strip()
    if env:
        return env
    return os.path.join("D:", os.sep, "Project", "Harness", "data")

MEM_DIR = os.path.join(_data_root(), "pid-memory")
DB_PATH = os.path.join(MEM_DIR, "lessons.db")
SESSION_PATH = os.path.join(MEM_DIR, "session.json")

# 滑动窗口与容量上限（可通过参数覆盖）
MAX_ROUNDS = 12        # 短期：同一会话最多保留最近 N 轮
MAX_LESSONS = 500      # 长期：经验库条数上限，超限触发去重合并
MAX_RECIPES = 100      # 宏指令条数上限
DEFAULT_TAGS = "pid,调参"


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _db():
    os.makedirs(MEM_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lessons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          outcome TEXT NOT NULL,       -- success / fail
          goal TEXT,                   -- 目的
          solution TEXT,               -- 方案（具体调整动作）
          result TEXT,                 -- 结果（指标变化）
          pain TEXT,                   -- 痛点 / 踩坑
          tags TEXT,                   -- 逗号分隔标签
          created_at TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recipes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL,       -- 触发条件（如：超调>20%）
          macro TEXT NOT NULL,         -- 一键宏指令（动作序列）
          tags TEXT,
          wins INTEGER DEFAULT 0,      -- 复用成功次数
          created_at TEXT,
          updated_at TEXT
        )""")
    conn.commit()
    return conn


def _read_session():
    try:
        with open(SESSION_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"goal": "", "params": {}, "rounds": []}


def _write_session(s):
    os.makedirs(MEM_DIR, exist_ok=True)
    with open(SESSION_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)


def _group_key(r):
    """同类判定：以 outcome + 首标签 归组，用于去重合并。"""
    tags = [t.strip() for t in (r.get("tags") or "").split(",") if t.strip()]
    first = tags[0] if tags else "untagged"
    return "%s|%s" % (r.get("outcome", "?"), first)


def _consolidate_lessons(limit=MAX_LESSONS, force=False):
    """同类踩坑去重合并，新解法覆盖旧解法（保留最新一条，合并痛点/结果）。
    自动场景（记录超限）按 limit 判断；手动场景 force=True 总是合并同类。"""
    conn = _db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM lessons ORDER BY created_at, id")]
    if not force and len(rows) <= limit:
        return {"kept": len(rows), "merged": 0}
    groups = {}
    for r in rows:
        groups.setdefault(_group_key(r), []).append(r)
    keep_ids = []
    merged = 0
    for items in groups.values():
        items.sort(key=lambda x: (x["created_at"] or "", x["id"]))
        best = items[-1]  # 最新一条（新解法覆盖旧解法）
        # 合并旧条目的痛点/结果到最新一条
        pains = [best["pain"]] if best["pain"] else []
        results = [best["result"]] if best["result"] else []
        for it in items[:-1]:
            merged += 1
            if it["pain"] and it["pain"] not in pains:
                pains.append(it["pain"])
            if it["result"] and it["result"] not in results:
                results.append(it["result"])
        best["pain"] = "；".join(dict.fromkeys(pains))[:500] or None
        best["result"] = "；".join(dict.fromkeys(results))[:500] or None
        conn.execute("UPDATE lessons SET pain=?, result=?, solution=? WHERE id=?",
                     (best["pain"], best["result"], best["solution"], best["id"]))
        keep_ids.append(best["id"])
    # 删除被合并掉的旧条目
    ph = ",".join("?" * len(keep_ids))
    conn.execute("DELETE FROM lessons WHERE id NOT IN (%s)" % ph, keep_ids)
    conn.commit()
    return {"kept": len(keep_ids), "merged": merged}


def _consolidate_recipes(limit=MAX_RECIPES, force=False):
    """宏指令窗口：同类触发条件只保留最新解法，旧宏覆盖。force=True 总是覆盖同类。"""
    conn = _db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM recipes ORDER BY created_at, id")]
    if not force and len(rows) <= limit:
        return {"kept": len(rows), "merged": 0}
    seen = {}
    keep = []
    merged = 0
    for r in rows:
        key = (r["trigger"] or "").strip()
        if key in seen:
            merged += 1
            conn.execute("DELETE FROM recipes WHERE id=?", (r["id"],))
        else:
            seen[key] = True
            keep.append(r["id"])
    conn.commit()
    return {"kept": len(keep), "merged": merged}


TOOLS = [
    {
        "name": "mem_get_session",
        "description": "读取本次 PID 调参的短期记忆：目标（goal）、当前参数（params，含 Kp/Ki/Kd/限幅）、最近几轮迭代记录（rounds，滑动窗口，最多保留最近 12 轮）。何时用（when to use）：每次调参开始前、或想确认当前会话目标/参数/最近轮次时调用。",
        "parameters": {"type": "object", "properties": {}},
        "handler": "mem_get_session"
    },
    {
        "name": "mem_update_session",
        "description": "更新短期记忆：设置本次调参目标、当前参数，并追加一轮迭代记录（如 'Kp=0.8 超调32%'）。同一会话只保留最近 12 轮，超出自动丢弃最旧轮次。何时用（when to use）：每轮实验结束后调用，记录目标、当前参数与本轮结果。",
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "本次调参目标，如 '超调<15% 且稳定时间<0.5s'"},
                "params": {"type": "object", "description": "当前 PID 参数 {kp, ki, kd, min, max}"},
                "round": {"type": "string", "description": "本轮迭代摘要，如 'Kp 0.8→0.55，超调 32%→9%'"}
            }
        },
        "handler": "mem_update_session"
    },
    {
        "name": "mem_record_lesson",
        "description": "记录一条长期经验（成功或失败）。记录格式：目的-方案-结果-痛点，带标签。何时用（when to use）：调参出现明显成功或失败时立即调用，沉淀经验供后续查询复用。",
        "parameters": {
            "type": "object",
            "properties": {
                "outcome": {"type": "string", "description": "success 或 fail"},
                "goal": {"type": "string", "description": "目的，如 '消除阶跃响应超调'"},
                "solution": {"type": "string", "description": "方案，如 'Kp 0.8→0.55，Ki 不变'"},
                "result": {"type": "string", "description": "结果，如 '超调 32%→9%，稳定时间 0.8s→0.45s'"},
                "pain": {"type": "string", "description": "痛点/踩坑，如 'Ki 过大会振荡'"},
                "tags": {"type": "string", "description": "逗号分隔标签，如 '超调,阶跃,电机A'"}
            },
            "required": ["outcome", "goal", "solution"]
        },
        "handler": "mem_record_lesson"
    },
    {
        "name": "mem_query_lessons",
        "description": "按标签/成败查询长期经验库（SQLite），返回匹配的经验列表。何时用（when to use）：调参前想查同类历史经验（复用成功方案、避开失败痛点）时调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "tags": {"type": "string", "description": "逗号分隔标签过滤，如 '超调' 或 '电机A'"},
                "outcome": {"type": "string", "description": "可选，只查 success 或 fail"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 10"}
            }
        },
        "handler": "mem_query_lessons"
    },
    {
        "name": "mem_make_recipe",
        "description": "把一条成功的调参经验提炼成程序性记忆（宏指令）：给出触发条件与一键执行的动作序列。何时用（when to use）：同一调参策略连续成功 2 次以上时调用，把成功路径过滤废话后固化为宏。",
        "parameters": {
            "type": "object",
            "properties": {
                "trigger": {"type": "string", "description": "触发条件，如 '阶跃响应超调>20%'"},
                "macro": {"type": "string", "description": "一键宏指令（动作序列），如 'Kp*=0.7 → 重跑step_test → 超调<15%则停止'"},
                "tags": {"type": "string", "description": "逗号分隔标签，与经验同源，便于归并"}
            },
            "required": ["trigger", "macro"]
        },
        "handler": "mem_make_recipe"
    },
    {
        "name": "mem_apply_recipe",
        "description": "按触发条件应用宏指令：匹配当前情况（如超调/振荡描述），返回对应的一键宏动作序列，并记录一次复用。何时用（when to use）：当前情况与某个宏的触发条件吻合（如出现超调大、振荡）时调用，直接按宏执行。",
        "parameters": {
            "type": "object",
            "properties": {
                "condition": {"type": "string", "description": "当前情况描述，如 '超调 25% 有轻微振荡'"}
            },
            "required": ["condition"]
        },
        "handler": "mem_apply_recipe"
    },
    {
        "name": "mem_catalog",
        "description": "返回经验库目录（按标签分组的索引）：每个标签的成功/失败条数、最新经验目的，以及全部宏指令列表。何时用（when to use）：调参开始时先调用，看有哪些可用经验，据此输出路由标签决定本次需要哪些。",
        "parameters": {"type": "object", "properties": {}},
        "handler": "mem_catalog"
    },
    {
        "name": "mem_route",
        "description": "经验路由：接收大模型输出的路由标签（逗号分隔，如 '超调,电机A'），程序直接查询对应经验与宏，组装成可直接拼进 prompt 的【参考经验】段落。何时用（when to use）：得到路由标签后、做调参决策前调用，把历史经验注入当前上下文。",
        "parameters": {
            "type": "object",
            "properties": {
                "tags": {"type": "string", "description": "路由标签，逗号分隔，来自大模型对 mem_catalog 的分析（如 '超调,振荡,电机A'）"},
                "limit": {"type": "integer", "description": "每条经验最多返回条数，默认 5"}
            },
            "required": ["tags"]
        },
        "handler": "mem_route"
    },
    {
        "name": "mem_consolidate",
        "description": "手动执行记忆压缩：同类踩坑去重合并、新解法覆盖旧解法（经验库 >500 条或宏 >100 条时也会自动触发）。何时用（when to use）：调参结束收尾、经验过多或复盘整理时调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "lessons_limit": {"type": "integer", "description": "经验库条数上限，默认 500"},
                "recipes_limit": {"type": "integer", "description": "宏条数上限，默认 100"}
            }
        },
        "handler": "mem_consolidate"
    }
]

# ---------------- handlers ----------------

def mem_get_session(args):
    s = _read_session()
    return json.dumps(s, ensure_ascii=False, indent=2)


def mem_update_session(args):
    s = _read_session()
    if args.get("goal"):
        s["goal"] = str(args["goal"])
    p = args.get("params")
    if isinstance(p, dict):
        s["params"] = p
    r = str(args.get("round") or "").strip()
    if r:
        s.setdefault("rounds", []).append({"t": _now(), "note": r})
    # 滑动窗口：只保留最近 MAX_ROUNDS 轮
    s["rounds"] = s.get("rounds", [])[-MAX_ROUNDS:]
    _write_session(s)
    return "短期记忆已更新（保留最近 %d 轮）: 目标=%s，参数=%s，轮次数=%d" % (
        MAX_ROUNDS, s.get("goal"), json.dumps(s.get("params", {}), ensure_ascii=False), len(s.get("rounds", [])))


def mem_record_lesson(args):
    outcome = str(args.get("outcome") or "").strip().lower()
    if outcome not in ("success", "fail"):
        raise ValueError("outcome 必须是 success 或 fail")
    goal = str(args.get("goal") or "").strip()
    if not goal:
        raise ValueError("缺少 goal 参数")
    solution = str(args.get("solution") or "").strip()
    tags = str(args.get("tags") or DEFAULT_TAGS).strip()
    conn = _db()
    conn.execute(
        "INSERT INTO lessons (outcome, goal, solution, result, pain, tags, created_at) VALUES (?,?,?,?,?,?,?)",
        (outcome, goal, solution,
         str(args.get("result") or "").strip(),
         str(args.get("pain") or "").strip(),
         tags, _now()))
    conn.commit()
    n = conn.execute("SELECT COUNT(*) AS c FROM lessons").fetchone()["c"]
    merged = 0
    if n > MAX_LESSONS:
        r = _consolidate_lessons(MAX_LESSONS)
        merged = r["merged"]
    return "经验已记录[%s]: %s（标签: %s）；当前 %d 条%s" % (
        outcome, goal, tags, min(n, MAX_LESSONS), ("，自动去重合并 %d 条同类踩坑" % merged) if merged else "")


def mem_query_lessons(args):
    conn = _db()
    sql = "SELECT * FROM lessons WHERE 1=1"
    params = []
    tags = str(args.get("tags") or "").strip()
    outcome = str(args.get("outcome") or "").strip()
    if tags:
        for t in [x.strip() for x in tags.split(",") if x.strip()]:
            sql += " AND tags LIKE ?"
            params.append("%" + t + "%")
    if outcome:
        sql += " AND outcome=?"
        params.append(outcome)
    limit = max(1, min(int(args.get("limit", 10)), 50))
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = [dict(r) for r in conn.execute(sql, params)]
    if not rows:
        return "无匹配经验（tags=%s outcome=%s）" % (tags or "*", outcome or "*")
    lines = []
    for r in rows:
        lines.append("[%s] %s | 方案: %s | 结果: %s | 痛点: %s | 标签: %s | %s" % (
            r["outcome"], r["goal"], r["solution"] or "-", r["result"] or "-", r["pain"] or "-", r["tags"], r["created_at"]))
    return "\n".join(lines)


def mem_catalog(args):
    conn = _db()
    lessons = conn.execute("SELECT tags, outcome, goal FROM lessons ORDER BY created_at DESC").fetchall()
    cats = {}
    for r in lessons:
        tags = [t.strip() for t in (r["tags"] or "").split(",") if t.strip()]
        first = tags[0] if tags else "未分类"
        c = cats.setdefault(first, {"success": 0, "fail": 0, "goals": []})
        c["success" if r["outcome"] == "success" else "fail"] += 1
        if r["goal"] and len(c["goals"]) < 2:
            c["goals"].append(r["goal"])
    lines = ["== 经验目录（按标签分组）=="]
    if not cats:
        lines.append("（暂无经验，可先用 mem_record_lesson 记录）")
    for tag in sorted(cats):
        c = cats[tag]
        lines.append("- [%s] 成功%d / 失败%d | 例: %s" % (
            tag, c["success"], c["fail"], "；".join(c["goals"]) or "-"))
    recs = conn.execute("SELECT trigger, macro FROM recipes ORDER BY wins DESC").fetchall()
    lines.append("== 宏指令目录 ==")
    if not recs:
        lines.append("（暂无宏，可先用 mem_make_recipe 提炼）")
    for r in recs:
        lines.append("- [%s] -> %s" % (r["trigger"], r["macro"]))
    return "\n".join(lines)


def mem_route(args):
    tags = str(args.get("tags") or "").strip()
    if not tags:
        raise ValueError("缺少 tags 参数（大模型输出的路由标签）")
    limit = max(1, min(int(args.get("limit", 5)), 20))
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    conn = _db()
    rows = []
    if tag_list:
        # 路由查询：任一标签命中即返回（OR 逻辑），与精确查询（AND）区分
        conds = " OR ".join("tags LIKE ?" for _ in tag_list)
        params = ["%" + t + "%" for t in tag_list]
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM lessons WHERE (%s) ORDER BY created_at DESC LIMIT ?" % conds,
            params + [limit])]
    import re
    zh = lambda s: re.sub(r"[^\u4e00-\u9fa5]", "", s)  # 只留中文，容错匹配
    rec_hits = []
    for r in conn.execute("SELECT trigger, macro, wins, tags AS rtags FROM recipes"):
        r = dict(r)
        trig = r["trigger"] or ""
        tz = zh(trig)
        mac_tags = [x.strip() for x in (r.get("rtags") or "").split(",") if x.strip()]
        hit = False
        for t in tag_list:
            tz2 = zh(t)
            if (tz and (tz in tz2 or tz2 in tz)) or (trig and t in trig):
                hit = True
                break
            if not hit and any(t in mt for mt in mac_tags):
                hit = True
        if hit:
            rec_hits.append("触发[%s] -> 执行: %s（复用 %d 次）" % (trig, r["macro"], r["wins"]))
    parts = ["【当前路由标签】" + tags]
    if rows:
        exp = []
        for r in rows:
            exp.append("[%s] %s | 方案: %s | 结果: %s | 痛点: %s | 标签: %s" % (
                r["outcome"], r["goal"], r["solution"] or "-", r["result"] or "-", r["pain"] or "-", r["tags"]))
        parts.append("【参考经验】\n" + "\n".join(exp))
    else:
        parts.append("【参考经验】（无匹配，可先 mem_catalog 看全部目录）")
    parts.append("【参考宏】\n" + ("\n".join(rec_hits) if rec_hits else "（无匹配）"))
    return "\n\n".join(parts)


def mem_make_recipe(args):
    trigger = str(args.get("trigger") or "").strip()
    macro = str(args.get("macro") or "").strip()
    if not trigger or not macro:
        raise ValueError("trigger 和 macro 都不能为空")
    tags = str(args.get("tags") or DEFAULT_TAGS).strip()
    conn = _db()
    # 同类触发条件：新解法直接覆盖旧宏（程序性记忆是对经验库的操作）
    conn.execute("DELETE FROM recipes WHERE trigger=?", (trigger,))
    conn.execute(
        "INSERT INTO recipes (trigger, macro, tags, wins, created_at, updated_at) VALUES (?,?,?,0,?,?)",
        (trigger, macro, tags, _now(), _now()))
    conn.commit()
    merged = 0
    n = conn.execute("SELECT COUNT(*) AS c FROM recipes").fetchone()["c"]
    if n > MAX_RECIPES:
        merged = _consolidate_recipes(MAX_RECIPES)["merged"]
    return "宏已保存: [%s] -> %s（覆盖同类旧宏）" % (trigger, macro)


def mem_apply_recipe(args):
    cond = str(args.get("condition") or "").strip().lower()
    if not cond:
        raise ValueError("缺少 condition 参数")
    conn = _db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM recipes")]
    if not rows:
        return "暂无宏指令，可先用 mem_make_recipe 从成功经验提炼"
    import re
    zh = lambda s: re.sub(r"[^\u4e00-\u9fa5]", "", s)  # 只保留中文关键词，用于容错匹配
    cz = zh(cond)
    hit = None
    for r in rows:
        trig = (r["trigger"] or "").strip()
        tz = zh(trig)
        # 命中：中文关键词子串包含（双向）或标签词出现在情况描述中
        matched = bool(tz and (tz in cz or cz in tz)) or any(
            t.strip() and t.strip() in cond for t in (r.get("tags") or "").split(",") if t.strip())
        if matched:
            hit = r
            break
    if hit:
        conn.execute("UPDATE recipes SET wins=wins+1 WHERE id=?", (hit["id"],))
        conn.commit()
        return "命中宏: [%s]\n执行: %s\n（复用次数 %d）" % (hit["trigger"], hit["macro"], hit["wins"] + 1)
    cand = "\n".join("- [%s] %s" % (r["trigger"], r["macro"]) for r in rows[:8])
    return "未精确命中，当前可用宏：\n" + cand


def mem_consolidate(args):
    lr = _consolidate_lessons(int(args.get("lessons_limit", MAX_LESSONS)), force=True)
    rr = _consolidate_recipes(int(args.get("recipes_limit", MAX_RECIPES)), force=True)
    return "记忆压缩完成：经验库去重合并 %d 条（剩 %d），宏覆盖 %d 条（剩 %d）" % (
        lr["merged"], lr["kept"], rr["merged"], rr["kept"])
