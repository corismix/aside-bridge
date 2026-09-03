"""Real end-to-end: uses a live throwaway aside session + real model.
Harmless reversible action (write a temp file) so approve/deny has a
verifiable, side-effect-safe outcome. Never touches the live bridge
session or state.json."""
import importlib.util
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# This test drives a real Aside CLI session, so it only runs on the
# bridge machine: anywhere without a local config.json, skip cleanly.
if not os.path.exists(os.path.join(HERE, "config.json")):
    print("manual test, skipping: needs a local config.json "
          "(run setup.py on the bridge machine)")
    sys.exit(0)

spec = importlib.util.spec_from_file_location(
    "bridgemod", os.path.join(HERE, "bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# bridge.py resolves ASIDE_CLI/SESSIONS_DIR from config via ~ which
# depends on $HOME; if a sandboxed runner has a different $HOME, fall
# back to the invoking user's real home (no hardcoded username).
import pwd
_HOME = pwd.getpwuid(os.getuid()).pw_dir
if not os.path.exists(b.ASIDE_CLI):
    b.ASIDE_CLI = os.path.join(
        _HOME, ".aside/cli/Aside CLI.app/Contents/MacOS/aside")
if not os.path.isdir(b.SESSIONS_DIR):
    b.SESSIONS_DIR = os.path.join(_HOME, ".aside/u/0/sessions")

if not os.path.exists(b.ASIDE_CLI) or not os.path.isdir(b.SESSIONS_DIR):
    print("manual test, skipping: no macOS Aside install found "
          "(Aside CLI / sessions dir missing)")
    sys.exit(0)

SENT = []
b.tg = lambda m, p=None, timeout=65: (
    SENT.append((m, p or {})) or {"ok": True, "result": {"message_id": 4242}})
b.save_json = lambda *a, **k: None
b.tg_send_status = lambda t: None
b.tg_edit = lambda *a, **k: True
b.tg_delete = lambda *a, **k: None

MODE = sys.argv[1] if len(sys.argv) > 1 else "approve"
assert MODE in ("approve", "deny")
print("MODE:", MODE)
TARGET = "/tmp/approval_demo_%d.txt" % os.getpid()
if os.path.exists(TARGET):
    os.unlink(TARGET)

print("creating throwaway session...")
subprocess.run([b.ASIDE_CLI, "exec", "-m", "claude-sonnet-5",
                "--effort", "low", "reply 'ready' and nothing else"],
               capture_output=True, text=True, timeout=180)
time.sleep(1)
sid = b.newest_session_id(exclude="", newer_than=time.time() - 300)
assert sid, "could not find created session"
print("session:", sid)
b.state["session_id"] = sid
b.state["model"] = "claude-sonnet-5"
b.state["effort_next"] = "low"
b.state["approval"] = None

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# turn 1: ask for an action that must be gated
print("\n--- turn 1: request that needs approval ---")
b.handle_message(
    "Create a file at %s containing exactly the word hello. This writes "
    "to my filesystem, an external side effect, so follow your approval "
    "protocol: request my approval first and do NOT create it yet." % TARGET)

approved_msg = [s for s in SENT if s[0] == "sendMessage"
                and "Approval needed" in (s[1].get("text") or "")]
check("turn1: approval buttons shown", len(approved_msg) >= 1)
check("turn1: pending approval recorded", b.state.get("approval") is not None)
check("turn1: file NOT created yet (action held)",
      not os.path.exists(TARGET))

if b.state.get("approval"):
    tok = b.state["approval"]["token"]
    print("\n--- turn 2: tap %s ---" % MODE)
    while not b.TASKS.empty():
        b.TASKS.get_nowait()
    b._handle_approval_tap("apv:%s:%s" % (MODE, tok), 4242)
    kind, payload = b.TASKS.get_nowait()
    tag = "GRANTED" if MODE == "approve" else "DENIED"
    check("tap: %s msg queued" % MODE, kind == "msg" and tag in payload)
    b.handle_message(payload)
    exists = os.path.exists(TARGET)
    if MODE == "approve":
        ok = exists
        if ok:
            with open(TARGET) as f:
                ok = "hello" in f.read().lower()
        check("turn2: file created after approval", ok)
    else:
        check("turn2: file NOT created after deny", not exists)
    if os.path.exists(TARGET):
        os.unlink(TARGET)

# cleanup: archive the throwaway session
try:
    subprocess.run([b.ASIDE_CLI, "repl",
                    "aside.sessions.archive('%s')" % sid],
                   capture_output=True, timeout=30)
except Exception:
    pass

print("\n%d failed" % len(fails))
sys.exit(1 if fails else 0)
