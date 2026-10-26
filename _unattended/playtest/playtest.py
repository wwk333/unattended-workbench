#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""试玩（playtest）—— 给审核一双真手真眼。

用途：不是"跑个脚本看退出码"，而是像人一样 **启动产品 → 按键 → 看画面**，
并把"连贯的画面"压成 **几个能判的数 + 几张关键帧**，交给审核模型。

为什么不是截图：截图 1 秒 1 张，抖动（5–15Hz）、出招动作、连招全漏。
这里按 60fps 录，算指标，再只抽 8–12 帧。

用法：
    python playtest.py run --exe "<游戏 exe 的完整路径>" --title "格斗名将" ^
        --seconds 25 --keys "enter@2,a@5,right@7:0.8,a@9" --out runs/demo

    python playtest.py record --title "记事本" --seconds 10 --out runs/rec

产出（--out 目录）：
    metrics.json     fps / shimmer（抖）/ response（按键后有没有反应）/ frozen（卡死）
    frames/*.png     关键帧（首帧、每 5 秒、每次按键前后）
    report.md        人看的结论
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

try:
    import mss
except ImportError:  # pragma: no cover
    sys.exit("缺 mss：python -m pip install mss")

user32 = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

SW_RESTORE = 9
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
VK = {
    "enter": 0x0D, "esc": 0x1B, "space": 0x20, "tab": 0x09,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "shift": 0x10, "ctrl": 0x11, "alt": 0x12,
    "a": 0x41, "b": 0x42, "c": 0x43, "d": 0x44, "e": 0x45, "f": 0x46,
    "g": 0x47, "h": 0x48, "i": 0x49, "j": 0x4A, "k": 0x4B, "l": 0x4C,
    "m": 0x4D, "n": 0x4E, "o": 0x4F, "p": 0x50, "q": 0x51, "r": 0x52,
    "s": 0x53, "t": 0x54, "u": 0x55, "v": 0x56, "w": 0x57, "x": 0x58,
    "y": 0x59, "z": 0x5A,
}


# ── 窗口 ────────────────────────────────────────────────────────────────
def find_window(title_part: str) -> int:
    """按标题子串找窗口（跳过不可见的）。"""
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if title_part.lower() in buf.value.lower():
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(_cb, 0)
    return found


def focus_window(hwnd: int) -> bool:
    """把窗口提到前台；Windows 只给"刚发过输入"的进程让位，这里先敲一下 ALT。"""
    user32.ShowWindow(hwnd, SW_RESTORE)
    try:
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        pass
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)
    return user32.GetForegroundWindow() == hwnd


def client_rect(hwnd: int) -> tuple[int, int, int, int]:
    rc = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rc))
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y, rc.right - rc.left, rc.bottom - rc.top


# ── 键盘（SendInput，扫键码，不依赖第三方库）──────────────────────────────
class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTUNION(ctypes.Union):
    # ★ 必须带上 mi/hi：INPUT 的 union 按最大成员算大小（x64 = 40 字节）；
    #   只放 ki 会让 sizeof(INPUT)=32，SendInput 直接 87 错误、静默无效。
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT), ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


def _send(vk: int, up: bool) -> None:
    ki = _KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP if up else 0,
                     time=0, dwExtraInfo=None)
    inp = _INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=ki))
    sent = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))
    if sent != 1:
        raise ctypes.WinError(ctypes.get_last_error())


def press(key: str, hold: float = 0.05) -> None:
    vk = VK.get(key.lower())
    if vk is None:
        raise ValueError(f"不认识的键：{key}")
    _send(vk, False)
    time.sleep(hold)
    _send(vk, True)


def post_key(hwnd: int, key: str, hold: float = 0.05) -> None:
    """把按键直接投递到窗口消息队列（WM_KEYDOWN/UP）。

    为什么需要它：SendInput 要求"有活动的输入桌面"——远程桌面断开、
    会话锁屏时它会**静默无效**（返回 1 但谁也不收到）。PostMessage 不受此限，
    对 SDL/pygame 这类在窗口过程里处理 WM_KEYDOWN 的程序同样有效。
    """
    vk = VK.get(key.lower())
    if vk is None:
        raise ValueError(f"不认识的键：{key}")
    scan = user32.MapVirtualKeyW(vk, 0)
    lparam = (scan << 16) | 1
    user32.PostMessageW(hwnd, 0x0100, vk, lparam)      # WM_KEYDOWN
    time.sleep(hold)
    user32.PostMessageW(hwnd, 0x0101, vk, lparam | 0xC0000000)  # WM_KEYUP


# ── 录制 ────────────────────────────────────────────────────────────────
@dataclass
class FrameStat:
    t: float
    diff: float      # 全画面平均差（大动作才明显）
    cell: float      # 16×9 网格里"变化最大的那一格"（小角色的小动作也抓得到）
    dx: float
    dy: float
    resp: float


@dataclass
class Recorder:
    rect: tuple[int, int, int, int]
    fps: int = 60
    out_dir: Path = Path(".")
    save_video: bool = False
    _stop: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None
    palette: list = field(default_factory=list)   # 彩色小图（抽帧用）
    stats: list = field(default_factory=list)
    t0: float = 0.0
    frames: int = 0

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        x, y, w, h = self.rect
        region = {"left": x, "top": y, "width": w, "height": h}
        gray_prev = None
        video = None
        if self.save_video:
            video = cv2.VideoWriter(str(self.out_dir / "screen.mp4"),
                                    cv2.VideoWriter_fourcc(*"mp4v"), 30, (w, h))
        with mss.MSS() as sct:
            self.t0 = time.time()
            while not self._stop.is_set():
                tick = time.time()
                shot = np.asarray(sct.grab(region))[:, :, :3]      # BGR
                g = cv2.cvtColor(cv2.resize(shot, (320, 180)), cv2.COLOR_BGR2GRAY)
                diff = 0.0
                cell = 0.0
                dx = dy = 0.0
                if gray_prev is not None:
                    d = cv2.absdiff(g, gray_prev)
                    diff = float(np.mean(d)) / 255.0
                    # 缩到 16×9 再取最大格：角色只占画面 2%，平均差会被稀释到万分之一
                    cell = float(np.max(cv2.resize(d, (16, 9), interpolation=cv2.INTER_AREA))) / 255.0
                    (shift, resp) = cv2.phaseCorrelate(np.float32(gray_prev) / 255.0,
                                                       np.float32(g) / 255.0)
                    dx, dy = shift[0] * w / 320.0, shift[1] * h / 180.0
                self.stats.append(FrameStat(time.time() - self.t0, diff, cell, dx, dy,
                                            float(resp) if gray_prev is not None else 0.0))
                gray_prev = g
                self.frames += 1
                if self.frames % max(1, self.fps // 10) == 0:      # 保留 10Hz 彩色小图
                    self.palette.append((time.time() - self.t0,
                                         cv2.resize(shot, (480, 270))))
                if video is not None:
                    video.write(shot)
                spent = time.time() - tick
                time.sleep(max(0.0, 1.0 / self.fps - spent))
        if video is not None:
            video.release()


# ── 按键脚本 ─────────────────────────────────────────────────────────────
def parse_keys(spec: str) -> list[tuple[float, str, float]]:
    """`enter@2,a@5,right@7:0.8` → [(2.0,'enter',0.05), (5.0,'a',0.05), (7.0,'right',0.8)]"""
    out = []
    for part in filter(None, (p.strip() for p in spec.split(","))):
        key, _, rest = part.partition("@")
        at_s, _, hold_s = rest.partition(":")
        out.append((float(at_s), key.strip().lower(), float(hold_s) if hold_s else 0.05))
    return sorted(out)


# ── 分析 ────────────────────────────────────────────────────────────────
def _step_changed(rec: "Recorder", t0: float, mode: str = "action", delay: float = 2.0) -> bool:
    """**持久**的画面变化：按键前 0.3 秒 与 按键后 2 秒 两张图比。

    为什么不比"前后 0.5 秒"：淡入淡出、按钮高亮、光标闪烁都会让 0.5 秒内变化很大，
    但 2 秒后画面又回到原样——那不是"推进了"。只有 2 秒后仍明显不同，才算推进。
    """
    # 两种判据：
    #   transition（进对局/换场景）：看 2 秒后是否仍不同（淡入淡出会回原样）
    #   action（出招/移动）：看 0.6 秒内是否明显比按键前更"炸"（出招是瞬时的，2 秒后已回待机）
    if mode == "transition":
        if not rec.palette:
            return False

        def near(at):
            return min(rec.palette, key=lambda p: abs(p[0] - at))[1]

        a = near(max(0.0, t0 - 0.3))
        b = near(t0 + delay)
        return a.shape == b.shape and float(np.mean(cv2.absdiff(a, b))) / 255.0 > 0.01

    after = [s.cell for s in rec.stats if t0 <= s.t <= t0 + 0.6]
    before = [s.cell for s in rec.stats if t0 - 0.65 <= s.t < t0 - 0.05]
    if not after:
        return False
    peak_after = max(after)
    peak_before = max(before) if before else 0.0
    return peak_after > max(peak_before * 1.3, 0.02)

def analyze(rec: Recorder, key_events: list[dict], out_dir: Path) -> dict:
    stats = rec.stats
    dur = stats[-1].t if stats else 0.0
    fps = len(stats) / dur if dur > 0 else 0.0

    # 静止段（没有按键的前后 1 秒）→ 抖动量
    quiet = [(s, e) for (s, e) in _gaps(key_events, dur) if e - s >= 1.0]
    quiet_dx = [abs(s.dx) for s in stats for (a, b) in quiet if a <= s.t <= b]
    quiet_dy = [abs(s.dy) for s in stats for (a, b) in quiet if a <= s.t <= b]
    shimmer = float(np.median(quiet_dx + quiet_dy)) if quiet_dx else 0.0

    # 按键后 0–300ms 的变化量 vs 静止基线
    base = float(np.median([s.diff for s in stats for (a, b) in quiet if a <= s.t <= b])) if quiet else 0.0
    resp = []
    for ev in key_events:
        t0 = ev["t"]
        # 游戏里"待机动画/计时器/背景"一直在动，拿"静止基线"比会失效。
        # 改成**配对比较**：按键后 0.3s 的最大格变化 vs 按键前 0.6s 的最大格变化。
        after = [s.cell for s in stats if t0 <= s.t <= t0 + 0.30]
        before = [s.cell for s in stats if t0 - 0.60 <= s.t < t0 - 0.05]
        peak = max(after) if after else 0.0
        pre = max(before) if before else 0.0
        base_cell = float(np.median([s.cell for s in stats for (a2, b2) in quiet if a2 <= s.t <= b2])) if quiet else 0.0
        resp.append({"key": ev["key"], "at": round(t0, 2),
                     "peak_cell": round(peak, 5),
                     "pre_cell": round(pre, 5),
                     "baseline_cell": round(base_cell, 5),
                     "reacted": bool(peak > max(pre * 1.25, 0.02))})

    # 卡死：连续 30 帧几乎完全相同
    frozen_runs, run = [], 0
    for s in stats:
        if s.diff < 0.0005:
            run += 1
        else:
            if run >= 30:
                frozen_runs.append({"from": round(s.t - run / max(fps, 1), 2), "frames": run})
            run = 0
    if run >= 30:
        frozen_runs.append({"from": round(dur - run / max(fps, 1), 2), "frames": run})

    # 抽帧：首帧、每 5 秒、每次按键前 0.2s 与后 0.15s
    want: list[tuple[str, float]] = [("first", 0.0)]
    t = 5.0
    while t < dur:
        want.append((f"t{int(t):02d}s", t))
        t += 5.0
    for ev in key_events:
        want.append((f"before_{ev['key']}", max(0.0, ev["t"] - 0.2)))
        want.append((f"after_{ev['key']}", min(dur, ev["t"] + 0.15)))
    frames = []
    if rec.palette:
        for name, at in want:
            if at > dur:
                continue
            ts, img = min(rec.palette, key=lambda p: abs(p[0] - at))
            fn = f"{name}.png"
            _imwrite(out_dir / "frames" / fn, img)
            frames.append({"name": name, "at": round(ts, 2), "file": f"frames/{fn}"})

    # ★ 画面"动没动"不能只看中位数：AI 走到距离就停，中位数会≈0，把"走的那两秒"吃掉。
    #   这里额外给最大值、P95、以及每秒的峰值，供审核判断"有没有动过"。
    diffs = np.array([s.diff for s in stats]) if stats else np.array([0.0])
    per_sec = {}
    for s in stats:
        sec = int(s.t)
        per_sec[sec] = max(per_sec.get(sec, 0.0), s.diff)
    motion_secs = sorted(k for k, v in per_sec.items() if v > 0.002)

    return {
        "duration_s": round(dur, 2),
        "fps": round(fps, 1),
        "frames": len(stats),
        "diff_max": round(float(diffs.max()), 5),
        "diff_p95": round(float(np.percentile(diffs, 95)), 5),
        "diff_median": round(float(np.median(diffs)), 5),
        "motion_secs": motion_secs,
        "per_sec_max": {str(k): round(v, 5) for k, v in sorted(per_sec.items())},
        "shimmer_px": round(shimmer, 2),
        "static_baseline": round(base, 5),
        "reactions": resp,
        "frozen": frozen_runs,
        "frames_saved": frames,
    }


def _gaps(events: list[dict], dur: float) -> list[tuple[float, float]]:
    """按键之间、且离按键至少 1 秒的区间。"""
    marks = [0.0] + [e["t"] for e in events] + [dur]
    gaps = []
    for a, b in zip(marks, marks[1:]):
        if b - a > 2.0:
            gaps.append((a + 1.0, b - 1.0))
    return gaps


# ── 报告 ────────────────────────────────────────────────────────────────
def _imwrite(path: Path, img) -> None:
    """中文路径下 cv2.imwrite 会静默失败 —— 走 imencode + 写字节。"""
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError(f"编码失败：{path}")
    path.write_bytes(buf.tobytes())

def write_report(m: dict, out_dir: Path) -> str:
    lines = ["# 试玩报告", ""]
    lines += [f"- 时长：{m['duration_s']} 秒，录到 {m['frames']} 帧，实际 {m['fps']} fps",
              f"- 抖动量（静止段位移中位数）：**{m['shimmer_px']} px**"
              f"（越小越稳；>2px 且画面在来回跳 ⇒ 抖）",
              ""]
    reacted = [r for r in m["reactions"] if r["reacted"]]
    lines.append(f"## 按键反应（{len(reacted)}/{len(m['reactions'])} 有反应）")
    lines.append("")
    lines.append("| 键 | 时刻 | 最大格变化 | 静止基线 | 有反应 |")
    lines.append("|---|---|---|---|---|")
    for r in m["reactions"]:
        lines.append(f"| {r['key']} | {r['at']}s | {r['peak_cell']} | {r['baseline_cell']} | "
                     f"{'✅' if r['reacted'] else '❌'} |")
    lines.append("")
    if m["frozen"]:
        lines.append(f"## 卡死 {len(m['frozen'])} 段")
        for f_ in m["frozen"]:
            lines.append(f"- 从 {f_['from']}s 起连续 {f_['frames']} 帧几乎无变化")
        lines.append("")
    steps = m.get("steps") or []
    if steps:
        lines.append("## 每一步有没有推动画面")
        lines.append("")
        lines.append("| 键 | 时刻 | 画面变化 | 结论 |")
        lines.append("|---|---|---|---|")
        for s in steps:
            verdict = "✅ 有推进" if s.get("changed") else ("❌ 卡住（按键没生效）" if s.get("stuck") else "· 无变化")
            lines.append(f"| {s['key']} | {s['t']}s | {'有' if s.get('changed') else '无'} | {verdict} |")
        lines.append("")
    lines.append("## 关键帧")
    for f_ in m["frames_saved"]:
        lines.append(f"- {f_['at']}s → `{f_['file']}`")
    text = "\n".join(lines) + "\n"
    (out_dir / "report.md").write_text(text, encoding="utf-8")
    return text


# ── 主流程 ──────────────────────────────────────────────────────────────
def cmd_run(a) -> int:
    out = Path(a.out).expanduser().resolve()
    (out / "frames").mkdir(parents=True, exist_ok=True)

    proc = None
    if a.exe:
        exe = str(Path(a.exe).resolve())
        cwd = str(Path(exe).parent)
        # ★ 必须切断子进程的标准输出：否则 pythonw / cmd 会一直占着管道，
        #   调用方（以及管道的读者）会以为程序没结束，一直挂着。
        if exe.lower().endswith((".cmd", ".bat")):
            proc = subprocess.Popen(["cmd", "/c", exe], cwd=cwd,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            proc = subprocess.Popen([exe], cwd=cwd,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"已启动：{a.exe}")

    hwnd, title = 0, ""
    deadline = time.time() + a.wait
    while time.time() < deadline:
        hits = find_window(a.title) if a.title else []
        if hits:
            hwnd, title = hits[0]
            break
        time.sleep(0.3)
    if not hwnd:
        print(f"× 等不到标题包含「{a.title}」的窗口", file=sys.stderr)
        if proc:
            proc.terminate()
        return 2
    print(f"找到窗口：{title!r} hwnd={hwnd}")
    print("聚焦：", "成功" if focus_window(hwnd) else "失败（可能被其它窗口抢走）")
    time.sleep(0.8)

    rect = client_rect(hwnd)
    print(f"录制区域：{rect}")
    rec = Recorder(rect=rect, fps=a.fps, out_dir=out, save_video=a.video)
    rec.start()

    events = []
    t_start = time.time()
    for at, key, hold in parse_keys(a.keys or ""):
        while time.time() - t_start < at:
            time.sleep(0.02)
        events.append({"key": key, "t": time.time() - rec.t0})
        if a.inject == "post":
            post_key(hwnd, key, hold)
        else:
            press(key, hold)
        time.sleep(0.6)
        # ★ 每步都验证"画面变没变"：没变就别继续往下按——
        #   否则会对着选人界面按攻击键，得出"攻击没反应"的假结论。
        mode = "transition" if key.lower() in ("enter", "space", "esc", "tab") else "action"
        changed = _step_changed(rec, events[-1]["t"], mode)
        events[-1]["changed"] = changed
        print(f"  {time.time() - t_start:5.1f}s 按键 {key}（{hold}s）→ 画面{'有变化' if changed else '没变化'}")
        if not changed and len(events) == 1:
            print("！第一步就推不动画面：大概率卡在起始界面（按键没生效），后面的键不再按。")
            events[-1]["stuck"] = True
            break

    while time.time() - t_start < a.seconds:
        time.sleep(0.05)
    rec.stop()

    m = analyze(rec, events, out)
    m["steps"] = [{"key": e["key"], "t": round(e["t"], 2),
                   "changed": e.get("changed"), "stuck": e.get("stuck", False)} for e in events]
    (out / "metrics.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(m, out)
    print(f"\n完成：{out}")
    print(f"  fps={m['fps']}  抖动={m['shimmer_px']}px  "
          f"按键有反应 {sum(1 for r in m['reactions'] if r['reacted'])}/{len(m['reactions'])}  "
          f"卡死 {len(m['frozen'])} 段")
    if proc and a.kill:
        proc.terminate()
    return 0


def cmd_record(a) -> int:
    out = Path(a.out).expanduser().resolve()
    (out / "frames").mkdir(parents=True, exist_ok=True)
    hits = find_window(a.title)
    if not hits:
        print(f"× 找不到窗口：{a.title}", file=sys.stderr)
        return 2
    hwnd, title = hits[0]
    focus_window(hwnd)
    s = Recorder(rect=client_rect(hwnd), fps=a.fps, out_dir=out, save_video=a.video)
    s.start()
    time.sleep(a.seconds)
    s.stop()
    m = analyze(s, [], out)
    (out / "metrics.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(m, out)
    print(f"完成：{out}  fps={m['fps']} 抖动={m['shimmer_px']}px")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="试玩：启动产品、按键、录屏、算指标")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="启动 + 按键 + 录制 + 分析")
    r.add_argument("--exe", help="要启动的程序（不给则只对已有窗口录制）")
    r.add_argument("--title", required=True, help="窗口标题子串")
    r.add_argument("--seconds", type=float, default=20, help="录多久（默认 20 秒）")
    r.add_argument("--fps", type=int, default=60)
    r.add_argument("--keys", default="", help="按键脚本：enter@2,a@5,right@7:0.8")
    r.add_argument("--out", required=True)
    r.add_argument("--wait", type=float, default=30, help="等窗口出现的最长秒数")
    r.add_argument("--video", action="store_true", help="同时存 screen.mp4")
    r.add_argument("--inject", choices=["post", "send"], default="post",
                   help="按键注入方式：post=直接投递窗口消息（锁屏也可用，默认）；send=SendInput")
    r.add_argument("--kill", action="store_true", help="结束后关掉程序")
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("record", help="只录已有窗口（不按键）")
    c.add_argument("--title", required=True)
    c.add_argument("--seconds", type=float, default=10)
    c.add_argument("--fps", type=int, default=60)
    c.add_argument("--out", required=True)
    c.add_argument("--video", action="store_true")
    c.set_defaults(func=cmd_record)

    a = ap.parse_args()
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
