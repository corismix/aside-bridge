#!/usr/bin/env python3
"""Live monitor + kill switch for the Aside Telegram bridge.

Run in any terminal:  python3 ~/.aside/u/0/telegram-bridge/monitor.py

Streams, in one merged timeline:
  - bridge events (polling health, incoming msgs, commands, exec runs, replies)
  - the mobile session's agent activity (thinking text, TOOL calls, replies,
    per-turn cost) parsed live from its messages.jsonl
Follows /new session switches automatically.

Keys:
  k  KILL: stop bridge now + kill any in-flight aside exec turn
  r  restart bridge (also = start after a kill)
  s  status snapshot
  q  quit monitor (bridge keeps running)

Flags: --status (print snapshot and exit), --kill, --start
"""
import json
import os
import re
import select
import subprocess
import sys
import termios
import time
import tty

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BRIDGE_DIR, "bridge.log")
STATE_PATH = os.path.join(BRIDGE_DIR, "state.json")
SESSIONS_DIR = os.path.expanduser("~/.aside/u/0/sessions")
UID = os.getuid()

# The label is DETECTED, not hardcoded.
#
# This file used to pin `com.aside.telegram-bridge` while bridgemon.py
# detected between that and the legacy `com.saiamartya.aside-telegram-bridge`
# -- so on any machine running the legacy label (every install predating
# the public rename) `bridgemon watch` reported STOPPED for a bridge that
# was up, `--kill` booted out a service that did not exist, and `--start`
# bootstrapped a plist that was not on disk. All three failed silently.
# One detector, shared, is the fix.
sys.path.insert(0, BRIDGE_DIR)
try:
    from bridgemon import label as _detect_label, plist_path as _plist_path
except ImportError:  # bridgemon.py missing: fall back to the public label
    def _detect_label():
        return "com.aside.telegram-bridge"

    def _plist_path(lbl):
        return os.path.expanduser("~/Library/LaunchAgents/%s.plist" % lbl)


def bridge_label():
    return _detect_label()


def bridge_plist():
    return _plist_path(bridge_label())

C = {"dim": "\033[2m", "red": "\033[31m", "green": "\033[32m",
     "yellow": "\033[33m", "cyan": "\033[36m", "bold": "\033[1m",
     "0": "\033[0m"}


def paint(color, s):
    return C[color] + s + C["0"]


def now():
    return time.strftime("%H:%M:%S")


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def bridge_pid():
    try:
        out = subprocess.run(
            ["launchctl", "print", "gui/%d/%s" % (UID, bridge_label())],
            capture_output=True, text=True).stdout
        m = re.search(r"pid = (\d+)", out)
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def exec_pids():
    """PIDs of in-flight aside CLI turns spawned by the bridge."""
    try:
        out = subprocess.run(["pgrep", "-f", "MacOS/aside exec"],
                             capture_output=True, text=True).stdout
        return [int(p) for p in out.split()]
    except Exception:  # noqa: BLE001
        return []


def status_line():
    pid = bridge_pid()
    st = load_state()
    running = paint("green", "RUNNING pid %s" % pid) if pid else \
        paint("red", "STOPPED")
    inflight = exec_pids()
    extra = paint("yellow", " | turn in flight (pid %s)"
                  % ",".join(map(str, inflight))) if inflight else ""
    return "%s [bridge %s] session=%s model=%s pending=%s%s" % (
        paint("bold", "STATUS"), running, st.get("session_id", "?"),
        st.get("model", "?"), "yes" if st.get("pending") else "no", extra)


def kill_bridge():
    print(paint("red", "%s >>> KILL: stopping bridge + in-flight turns"
                % now()))
    subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (UID, bridge_label())],
                   capture_output=True)
    for pid in exec_pids():
        try:
            os.kill(pid, 15)
            print(paint("red", "  killed aside exec pid %d" % pid))
        except OSError:
            pass
    time.sleep(0.5)
    print(status_line())


def start_bridge():
    print(paint("green", "%s >>> starting bridge" % now()))
    subprocess.run(["launchctl", "bootstrap", "gui/%d" % UID, bridge_plist()],
                   capture_output=True)
    time.sleep(1.5)
    print(status_line())


class Tail:
    def __init__(self, path, from_end=True):
        self.path = path
        self.f = None
        self.pos = 0
        self.from_end = from_end

    def lines(self):
        if self.f is None:
            try:
                self.f = open(self.path)
                if self.from_end:
                    self.f.seek(0, 2)
                self.pos = self.f.tell()
            except OSError:
                return []
        try:
            if os.path.getsize(self.path) < self.pos:  # rotated/truncated
                self.f.seek(0)
            out = []
            for line in self.f:
                out.append(line.rstrip("\n"))
            self.pos = self.f.tell()
            return out
        except OSError:
            self.f = None
            return []


def session_msg_path(session_id):
    if not session_id:
        return None
    try:
        for name in os.listdir(SESSIONS_DIR):
            if name.endswith("_" + session_id):
                return os.path.join(SESSIONS_DIR, name, "messages.jsonl")
    except OSError:
        pass
    return None


def fmt_agent_event(m):
    role = m.get("role")
    out = []
    if role == "user":
        for p in m.get("content", []) if isinstance(m.get("content"), list) \
                else [{"type": "text", "text": str(m.get("content"))}]:
            if p.get("type") == "text":
                t = p["text"].replace("\n", " ")[:160]
                out.append(paint("cyan", "USER > ") + t)
    elif role == "assistant":
        for p in m.get("content", []):
            if p.get("type") == "text" and p.get("text", "").strip():
                out.append(paint("green", "AGENT> ")
                           + p["text"].replace("\n", " ")[:200])
            elif p.get("type") == "tool_use":
                arg = json.dumps(p.get("input", {}))[:150]
                out.append(paint("yellow", "TOOL > %s " % p.get("name"))
                           + paint("dim", arg))
        u = m.get("usage") or {}
        cost = ((u.get("cost") or {}).get("total"))
        if cost:
            out.append(paint("dim", "       turn: %sk ctx, $%.4f"
                             % (round((u.get("totalTokens") or 0) / 1000),
                                cost)))
    return out


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    args = sys.argv[1:]
    if "--status" in args:
        print(status_line())
        return
    if "--kill" in args:
        kill_bridge()
        return
    if "--start" in args:
        start_bridge()
        return

    print(paint("bold", "aside telegram bridge monitor"))
    print("keys: [k]ill  [r]estart  [s]tatus  [q]uit monitor\n")
    print(status_line())

    log_tail = Tail(LOG_PATH)
    cur_session = None
    msg_tail = None
    last_status = 0

    interactive = sys.stdin.isatty()
    if interactive:
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        tty.setcbreak(fd)
    try:
        while True:
            # keypresses
            if interactive:
                r, _, _ = select.select([sys.stdin], [], [], 0.5)
                if r:
                    ch = sys.stdin.read(1).lower()
                    if ch == "q":
                        print("bye. bridge unaffected.")
                        return
                    if ch == "k":
                        kill_bridge()
                    elif ch == "r":
                        subprocess.run(
                            ["launchctl", "bootout",
                             "gui/%d/%s" % (UID, bridge_label())],
                            capture_output=True)
                        start_bridge()
                    elif ch == "s":
                        print(status_line())
            else:
                time.sleep(0.5)

            # bridge log stream
            for line in log_tail.lines():
                color = "red" if ("error" in line.lower()
                                  or "broke" in line.lower()) else "dim"
                print(paint(color, "BRIDGE " + line))

            # follow the active session's transcript
            st = load_state()
            sid = st.get("session_id")
            if sid != cur_session:
                cur_session = sid
                path = session_msg_path(sid)
                msg_tail = Tail(path) if path else None
                print(paint("bold", "%s -- watching session %s"
                            % (now(), sid)))
            if msg_tail:
                for line in msg_tail.lines():
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue
                    for ev in fmt_agent_event(m):
                        print("%s %s" % (paint("dim", now()), ev))

            # periodic status heartbeat every 5 min
            if time.time() - last_status > 300:
                last_status = time.time()
                print(paint("dim", "%s %s" % (now(), status_line())))
    except KeyboardInterrupt:
        print("\nbye. bridge unaffected.")
    finally:
        if interactive:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


if __name__ == "__main__":
    main()
