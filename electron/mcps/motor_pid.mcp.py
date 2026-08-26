# ============================================================
# MCP: 电机 PID 串口工具（WiFi 透传链路）
# 用途：LAG harness 画布上，PID 调参 Agent 与 MCU 通信的桥梁。
#       MCU 侧数据经 WiFi 组件（ESP8266/ESP32 透传）到达电脑串口，
#       本工具负责组帧/解析，把电机状态、阶跃响应采样交给智能体，
#       并把大模型给出的 Kp/Ki/Kd 下发到 MCU。
# 依赖：pyserial（在「终端」页执行: pip install pyserial）
# 保存后在「工具/MCP」页点击「重载」生效。
# ============================================================
#
# ---------------- 传输链路 ----------------
#   MCU ──UART──> WiFi 模块(透传模式) ──WiFi──> 电脑串口(本工具)
#   协议帧在整个链路中透传，电脑侧只按下方帧格式解析即可。
#
# ---------------- 帧协议（二进制 + JSON 载荷） ----------------
#   帧 = HEADER(2B) + TYPE(1B) + LEN(2B,大端) + PAYLOAD(JSON) + CHECK(1B) + TAIL(2B)
#   HEADER : 0xAA 0x55
#   TYPE   : 见 TYPE_* 常量
#   LEN    : PAYLOAD 字节数（大端，≤1024）
#   PAYLOAD: UTF-8 JSON 对象字节
#   CHECK  : PAYLOAD 所有字节求和 & 0xFF
#   TAIL   : 0x0D 0x0A
#
# ---------------- 消息类型与载荷 ----------------
#   0x01 STATUS  上行  MCU 状态上报
#         {"speed":rpm, "position":deg, "current":A, "target":deg, "t_ms":0, "mode":"run|stop|step"}
#   0x02 SET_PID 下行  下发 PID 参数（本工具自动夹取到上下限）
#         {"kp":1.0, "ki":0.1, "kd":0.05, "min":0.0, "max":100.0}
#   0x03 CMD     下行  控制命令
#         {"mode":"run|stop|step_test|zero", "target":90.0, "duration_ms":2000}
#   0x04 ACK     上行  MCU 应答
#         {"ok":true, "msg":"pid applied", "type":"set_pid|cmd"}
#   0x05 SAMPLE  上行  阶跃响应采样（特征提取/仿真的真实数据源）
#         {"seq":12, "t_ms":240, "setpoint":90.0, "feedback":61.2, "output":78.5}
#   0x06 PID_QUERY 下行  查询当前 PID
#   0x07 PID_REPORT 上行  MCU 回当前 PID
#         {"kp":1.0, "ki":0.1, "kd":0.05, "min":0.0, "max":100.0}
# ============================================================

MCP_ID = "motor_pid"
MCP_NAME = "电机 PID 串口"
MCP_DESC = "电机 PID 调参链路工具：连接串口、读取电机状态与阶跃响应采样、下发 Kp/Ki/Kd 参数与控制命令（MCU 经 WiFi 透传）。"

try:
    import serial
    HAS_SERIAL = True
except Exception:
    HAS_SERIAL = False
    serial = None

import threading
import time
import json

# ---------------- 协议常量 ----------------
FRAME_HEAD = b"\xaa\x55"
FRAME_TAIL = b"\x0d\x0a"
T_STATUS = 0x01
T_SET_PID = 0x02
T_CMD = 0x03
T_ACK = 0x04
T_SAMPLE = 0x05
T_PID_QUERY = 0x06
T_PID_REPORT = 0x07

# PID 安全上下限（防止大模型下发越界值烧电机，可在 motor_connect 时覆盖）
DEFAULT_PID_MIN = 0.0
DEFAULT_PID_MAX = 100.0

# ---------------- 全局串口状态 ----------------
_ser = None          # pyserial 对象
_lock = threading.Lock()
_last_status = {}    # 最近一帧 STATUS
_pid_limits = {"min": DEFAULT_PID_MIN, "max": DEFAULT_PID_MAX}


def _need_serial():
    if not HAS_SERIAL:
        raise ValueError("未安装 pyserial，请在「终端」页执行: pip install pyserial")
    if _ser is None or not _ser.is_open:
        raise ValueError("串口未连接，请先调用 motor_connect(port, baud)")


def _frame(type_id, payload: dict) -> bytes:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(body) > 1024:
        raise ValueError("载荷超过 1024 字节")
    length = len(body).to_bytes(2, "big")
    check = (sum(body) & 0xFF).to_bytes(1, "big")
    return FRAME_HEAD + bytes([type_id]) + length + body + check + FRAME_TAIL


def _recv_frame(timeout=1.0):
    """状态机式读取一帧，返回 (type_id, payload_dict)；超时返回 None。"""
    if _ser is None:
        return None
    end = time.time() + timeout
    buf = b""
    while time.time() < end:
        if _ser.in_waiting:
            data = _ser.read(_ser.in_waiting)
            if data:
                buf += data
            while True:
                # 找帧头
                i = buf.find(FRAME_HEAD)
                if i < 0:
                    buf = buf[-1:]
                    break
                buf = buf[i:]
                if len(buf) < 6:
                    break  # HEAD(2)+TYPE(1)+LEN(2)+? 不足
                type_id = buf[2]
                plen = int.from_bytes(buf[3:5], "big")
                need = 5 + plen + 1 + 2
                if len(buf) < need:
                    break
                payload = buf[5:5 + plen]
                check = buf[5 + plen]
                tail = buf[5 + plen + 1:need]
                buf = buf[need:]
                if (sum(payload) & 0xFF) != check:
                    continue  # 校验失败，继续找下一帧
                if tail != FRAME_TAIL:
                    continue
                try:
                    obj = json.loads(payload.decode("utf-8"))
                except Exception:
                    obj = {}
                return type_id, obj
        else:
            time.sleep(0.005)
    return None


TOOLS = [
    {
        "name": "motor_connect",
        "description": "连接电脑串口（MCU 经 WiFi 透传接入）。port 如 'COM3' 或 '/dev/ttyUSB0'；baud 默认 115200；可传 pid_min/pid_max 设置 Kp/Ki/Kd 安全上下限。连接成功后会自动尝试读取一帧确认链路。何时用（when to use）：开始调参、准备操作电机前必须首先调用；未连接时其他 motor_* 工具不可用。",
        "parameters": {
            "type": "object",
            "properties": {
                "port": {"type": "string", "description": "串口号，如 COM3 / /dev/ttyUSB0"},
                "baud": {"type": "integer", "description": "波特率，默认 115200"},
                "pid_min": {"type": "number", "description": "PID 参数下界（防越界下发）"},
                "pid_max": {"type": "number", "description": "PID 参数上界"}
            },
            "required": ["port"]
        },
        "handler": "motor_connect"
    },
    {
        "name": "motor_disconnect",
        "description": "关闭并释放串口。何时用（when to use）：调参结束、断开电机或释放串口资源时调用。",
        "parameters": {"type": "object", "properties": {}},
        "handler": "motor_disconnect"
    },
    {
        "name": "motor_read_status",
        "description": "读取一帧 MCU 状态上报（速度 rpm、位置 position、电流 current、目标 target、模式 mode）。用于了解电机当前运行状态。何时用（when to use）：需要确认电机当前速度/位置/电流等运行状态时；执行任何动作前先确认状态。",
        "parameters": {
            "type": "object",
            "properties": {
                "timeout": {"type": "number", "description": "等待秒数，默认 1.0"}
            }
        },
        "handler": "motor_read_status"
    },
    {
        "name": "motor_set_pid",
        "description": "下发 PID 参数到 MCU（Kp/Ki/Kd）。会自动夹取到安全上下限内，并等待 MCU 应答。返回是否成功。何时用（when to use）：每轮调参确定要下发一组新 Kp/Ki/Kd 时；调整参数后必须调用它让新参数生效。",
        "parameters": {
            "type": "object",
            "properties": {
                "kp": {"type": "number", "description": "比例增益"},
                "ki": {"type": "number", "description": "积分增益"},
                "kd": {"type": "number", "description": "微分增益"}
            },
            "required": ["kp", "ki", "kd"]
        },
        "handler": "motor_set_pid"
    },
    {
        "name": "motor_command",
        "description": "向 MCU 下发控制命令。mode: run 运行到目标 / stop 停止 / step_test 阶跃测试 / zero 回零；target 目标位置(度)；duration_ms 阶跃测试时长。step_test 适合用来获取阶跃响应。何时用（when to use）：需要让电机运行/停止/回零，或做阶跃测试以获取响应数据时；调参循环的每次实验都靠它触发。",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "description": "run / stop / step_test / zero"},
                "target": {"type": "number", "description": "目标位置（度）"},
                "duration_ms": {"type": "integer", "description": "阶跃测试时长(ms)，默认 2000"}
            },
            "required": ["mode"]
        },
        "handler": "motor_command"
    },
    {
        "name": "motor_read_samples",
        "description": "连续读取阶跃响应采样帧（SAMPLE），收集 setpoint/feedback/output 序列，返回 CSV 文本（时间ms,目标,反馈,输出）。这是评估 PID 效果、计算超调/稳定时间的关键数据源。何时用（when to use）：执行 step_test 阶跃测试后必须调用，读取响应数据用于评估指标；不读它就无法判断调参效果。",
        "parameters": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "最多读取的采样点数，默认 50"},
                "timeout": {"type": "number", "description": "总等待秒数，默认 3.0"}
            }
        },
        "handler": "motor_read_samples"
    },
    {
        "name": "motor_query_pid",
        "description": "查询 MCU 当前生效的 PID 参数（发送查询并等待 PID_REPORT 应答）。何时用（when to use）：调参开始前确认当前参数、或不确定 MCU 上实际生效的 Kp/Ki/Kd 时调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "timeout": {"type": "number", "description": "等待秒数，默认 2.0"}
            }
        },
        "handler": "motor_query_pid"
    }
]

# ---------------- handlers ----------------

def motor_connect(args):
    if not HAS_SERIAL:
        raise ValueError("未安装 pyserial，请在「终端」页执行: pip install pyserial")
    port = str(args.get("port", "")).strip()
    if not port:
        raise ValueError("缺少 port 参数，如 COM3 或 /dev/ttyUSB0")
    global _ser
    _lock.acquire()
    try:
        if _ser is not None and _ser.is_open:
            try:
                _ser.close()
            except Exception:
                pass
        baud = int(args.get("baud", 115200))
        _ser = serial.Serial(port=port, baudrate=baud, timeout=0.1)
        _pid_limits["min"] = float(args.get("pid_min", DEFAULT_PID_MIN))
        _pid_limits["max"] = float(args.get("pid_max", DEFAULT_PID_MAX))
        time.sleep(0.2)
        _ser.reset_input_buffer()
    finally:
        _lock.release()
    # 尝试读一帧确认链路
    got = _recv_frame(timeout=1.0)
    info = "串口已连接: %s @ %s，PID 限幅 [%s, %s]" % (port, baud, _pid_limits["min"], _pid_limits["max"])
    if got:
        info += "；链路正常，收到 TYPE=0x%02X: %s" % (got[0], json.dumps(got[1], ensure_ascii=False))
    else:
        info += "；暂未收到数据（检查 MCU/WiFi 透传是否已上电）"
    return info


def motor_disconnect(args):
    global _ser
    _lock.acquire()
    try:
        if _ser is not None:
            try:
                _ser.close()
            except Exception:
                pass
            _ser = None
    finally:
        _lock.release()
    return "串口已关闭"


def motor_read_status(args):
    _need_serial()
    timeout = float(args.get("timeout", 1.0))
    got = _recv_frame(timeout=timeout)
    if got is None:
        return "未在 %.1fs 内收到状态帧" % timeout
    return "状态: " + json.dumps(got[1], ensure_ascii=False)


def motor_set_pid(args):
    _need_serial()
    lo, hi = _pid_limits["min"], _pid_limits["max"]
    kp = min(hi, max(lo, float(args.get("kp", 0))))
    ki = min(hi, max(lo, float(args.get("ki", 0))))
    kd = min(hi, max(lo, float(args.get("kd", 0))))
    with _lock:
        _ser.write(_frame(T_SET_PID, {"kp": kp, "ki": ki, "kd": kd, "min": lo, "max": hi}))
    got = _recv_frame(timeout=2.0)
    if got and got[0] == T_ACK and got[1].get("ok"):
        return "PID 已下发并被 MCU 接受: Kp=%.4f Ki=%.4f Kd=%.4f (限幅 [%s, %s])" % (kp, ki, kd, lo, hi)
    return "PID 已发送(Kp=%.4f Ki=%.4f Kd=%.4f)但未收到 MCU 确认（%s）" % (kp, ki, kd, got[1] if got else "无应答")


def motor_command(args):
    _need_serial()
    mode = str(args.get("mode", "")).strip()
    if mode not in ("run", "stop", "step_test", "zero"):
        raise ValueError("mode 必须是 run/stop/step_test/zero")
    payload = {"mode": mode, "target": float(args.get("target", 0)), "duration_ms": int(args.get("duration_ms", 2000))}
    with _lock:
        _ser.write(_frame(T_CMD, payload))
    got = _recv_frame(timeout=2.0)
    if got and got[0] == T_ACK and got[1].get("ok"):
        return "命令已执行: " + json.dumps(payload, ensure_ascii=False)
    return "命令已发送: %s（未收到 MCU 确认: %s）" % (json.dumps(payload, ensure_ascii=False), got[1] if got else "无应答")


def motor_read_samples(args):
    _need_serial()
    count = max(1, int(args.get("count", 50)))
    total_timeout = float(args.get("timeout", 3.0))
    rows = []
    end = time.time() + total_timeout
    while len(rows) < count and time.time() < end:
        got = _recv_frame(timeout=0.5)
        if got and got[0] == T_SAMPLE:
            s = got[1]
            rows.append((s.get("t_ms", 0), s.get("setpoint", 0), s.get("feedback", 0), s.get("output", 0)))
        elif got and got[0] == T_STATUS:
            _last_status.update(got[1])
    if not rows:
        return "未采集到采样帧（请先发送 step_test 命令）"
    lines = ["t_ms,setpoint,feedback,output"]
    lines += ["%d,%.3f,%.3f,%.3f" % (t, sp, fb, out) for (t, sp, fb, out) in rows]
    return "\n".join(lines)


def motor_query_pid(args):
    _need_serial()
    timeout = float(args.get("timeout", 2.0))
    with _lock:
        _ser.write(_frame(T_PID_QUERY, {}))
    got = _recv_frame(timeout=timeout)
    if got and got[0] == T_PID_REPORT:
        return "当前 PID: " + json.dumps(got[1], ensure_ascii=False)
    return "未收到 PID 上报（%s）" % (got[1] if got else "无应答")
