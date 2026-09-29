"""Offline regression checks for Telegram /stop; no live CLI or Telegram."""
import importlib.util
import json
import os
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.TemporaryDirectory(prefix="aside-bridge-stop-test-")
CONFIG = os.path.join(TMP.name, "config.json")
STATE = os.path.join(TMP.name, "state.json")
with open(CONFIG, "w", encoding="utf-8") as f:
    json.dump({
        "token": "123:TEST",
        "chat_id": 123,
        "owner_name": "Test Owner",
        "sessions_dir": os.path.join(TMP.name, "sessions"),
        "aside_cli": "/fake/aside",
        "default_model": "test/model",
        "default_effort": "high",
    }, f)
os.environ["ASIDE_BRIDGE_CONFIG"] = CONFIG
os.environ["ASIDE_BRIDGE_STATE"] = STATE
spec = importlib.util.spec_from_file_location(
    "bridgemod", os.path.join(HERE, "bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

TEXTS = []
b.send_text = TEXTS.append
b.save_json = lambda *args, **kwargs: None
b.state["pending"] = "the prompt that must not replay"
b.state["session_id"] = "selected-session-must-not-be-targeted"

while not b.TASKS.empty():
    b.TASKS.get_nowait()
b.TASKS.put(("msg", "waiting message one"))
b.TASKS.put(("cmd", "/usage"))
b.TASKS.put(("msg", "waiting message two"))

done = b.threading.Event()
settled = b.threading.Event()
settled.set()
decided = b.threading.Event()
b.ACTIVE_RUN = {
    "session_id": "active-run-session",
    "done": done,
    "settled": settled,
    "stop_decided": decided,
    "stop_confirmed": False,
}
b.WORKER_BUSY.set()
calls = []


class Result:
    returncode = 0
    stdout = ""
    stderr = ""


def fake_run(argv, **kwargs):
    calls.append((argv, kwargs))
    assert not done.is_set(), "Stop must be invoked before the driver settles"
    b.threading.Timer(0.01, lambda: (done.set(), settled.set())).start()
    return Result()


b.subprocess.run = fake_run
b.handle_command("/stop@samplebot")

assert calls and calls[0][0] == ["/fake/aside", "session", "stop", "active-run-session"]
assert "timeout" in calls[0][1] and "shell" not in calls[0][1]
assert b.state["pending"] is None
assert b.TASKS.qsize() == 1
assert b.TASKS.get_nowait() == ("cmd", "/usage")
assert any("cancelled 2 waiting message(s)" in message for message in TEXTS)
assert any("remain in chat" in message for message in TEXTS)

# A failed/timed-out stop keeps the queue and replay state intact.
b.TASKS.put(("msg", "keep me"))
b.state["pending"] = "keep this pending text"
b.ACTIVE_RUN = {
    "session_id": "active-run-session",
    "done": b.threading.Event(),
    "settled": b.threading.Event(),
    "stop_decided": b.threading.Event(),
    "stop_confirmed": False,
}
b.ACTIVE_RUN["settled"].set()
b.subprocess.run = lambda *args, **kwargs: type(
    "Failed", (), {"returncode": 1, "stdout": "", "stderr": "not running"}
)()
b.handle_command("/stop")
assert b.TASKS.qsize() == 1
assert b.TASKS.get_nowait() == ("msg", "keep me")
assert b.state["pending"] == "keep this pending text"
assert any("queued messages were kept" in message for message in TEXTS)

# Idle/bootstrap and malformed invocations must never reach the CLI.
b.ACTIVE_RUN = None
b.WORKER_BUSY.clear()
b.subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(
    AssertionError("idle Stop must not invoke the CLI"))
b.handle_command("/stop")
assert any("nothing is running" in message for message in TEXTS)
b.WORKER_BUSY.set()
b.handle_command("/stop")
assert any("not available yet" in message for message in TEXTS)
b.handle_command("/stop active-session")
assert any("usage: /stop" in message for message in TEXTS)
b.WORKER_BUSY.clear()

# A run that has already completed must not receive a late Stop request or
# cause pending/queued work to be discarded. Repeated taps after completion
# resolve as idle rather than issuing another CLI call.
b.TASKS.put(("msg", "keep after natural completion"))
b.state["pending"] = "pending after natural completion"
finished_run = {
    "session_id": "naturally-finished-session",
    "done": b.threading.Event(),
    "settled": b.threading.Event(),
    "stop_decided": b.threading.Event(),
    "stop_confirmed": False,
}
finished_run["done"].set()
finished_run["settled"].set()
b.ACTIVE_RUN = finished_run
before_natural_stop = len(calls)
b.handle_command("/stop")
b.handle_command("/stop")
assert len(calls) == before_natural_stop
assert b.TASKS.get_nowait() == ("msg", "keep after natural completion")
assert b.state["pending"] == "pending after natural completion"
assert sum("nothing is running" in message for message in TEXTS) >= 3

# An OS-level timeout leaves pending work and the waiting queue intact.
b.TASKS.put(("msg", "keep after timeout"))
b.state["pending"] = "pending after timeout"
b.ACTIVE_RUN = {
    "session_id": "active-run-session",
    "done": b.threading.Event(),
    "settled": b.threading.Event(),
    "stop_decided": b.threading.Event(),
    "stop_confirmed": False,
}
b.subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(
    b.subprocess.TimeoutExpired(args[0], kwargs.get("timeout")))
b.handle_command("/stop")
assert b.TASKS.get_nowait() == ("msg", "keep after timeout")
assert b.state["pending"] == "pending after timeout"
assert b.STOP_IN_PROGRESS is False

# A successful daemon Stop that leaves its CLI waiter blocked must terminate
# only the exact owned child and then settle through the worker cleanup path.
class FirstWaitFails:
    def __init__(self):
        self.event = b.threading.Event()
        self.calls = 0

    def wait(self, timeout=None):
        self.calls += 1
        if self.calls == 1:
            return False
        return self.event.wait(timeout)

    def set(self):
        self.event.set()

    def is_set(self):
        return self.event.is_set()


class OwnedChild:
    def __init__(self, settled_event):
        self.settled_event = settled_event
        self.exit_code = None
        self.terminated = 0
        self.killed = 0

    def poll(self):
        return self.exit_code

    def terminate(self):
        self.terminated += 1
        self.exit_code = -15
        self.settled_event.set()

    def kill(self):
        self.killed += 1
        self.exit_code = -9
        self.settled_event.set()


b.TASKS.put(("msg", "cancel after owned-child termination"))
b.state["pending"] = "clear after confirmed stop"
owned_settled = FirstWaitFails()
owned_child = OwnedChild(owned_settled)
process_started = b.threading.Event()
process_started.set()
b.ACTIVE_RUN = {
    "session_id": "active-run-session",
    "done": b.threading.Event(),
    "settled": owned_settled,
    "stop_decided": b.threading.Event(),
    "process_started": process_started,
    "process": owned_child,
    "stop_confirmed": False,
}
b.subprocess.run = lambda *args, **kwargs: type(
    "Stopped", (), {"returncode": 0, "stdout": "", "stderr": ""})()
b.handle_command("/stop")
assert owned_child.terminated == 1 and owned_child.killed == 0
assert owned_settled.is_set()
assert b.TASKS.empty()
assert b.state["pending"] is None
assert b.STOP_IN_PROGRESS is False

# Exercise the actual worker -> handle_message -> driver path with a fake
# blocking driver and fake stop CLI. This proves partial output survives,
# replay state is cleared, queued commands remain, and queued messages do not
# start another run after a successful stop.
while not b.TASKS.empty():
    b.TASKS.get_nowait()
b.state.update({
    "session_id": "driver-session",
    "model": "test/model",
    "effort_next": None,
    "pending": None,
})
b.save_json = lambda *args, **kwargs: None
b.session_msg_file = lambda _session_id: None
b.Typing = lambda: __import__("contextlib").nullcontext()
finished = b.threading.Event()
usage_handled = b.threading.Event()
driver_started = b.threading.Event()
release_driver = b.threading.Event()
driver_sessions = []


class FakeTurn:
    suppress_final = False

    def __init__(self):
        self.blocks = []

    def flush(self):
        pass

    def on_block(self, text):
        self.blocks.append(text)

    def finish(self):
        if self.blocks:
            TEXTS.append("\n".join(self.blocks))
        finished.set()


b.TurnStream = FakeTurn
b.stream_new = lambda _path, pos, turn: (
    turn.on_block("partial transcript output"), (pos, True)
)[1]
b.read_assistant_since = lambda *_args: ""
b.send_bubbles = lambda *_args: None
b.send_text = TEXTS.append
b.handle_usage = usage_handled.set


def blocking_driver(prompt, session_id=None, model=None, effort=None):
    driver_sessions.append(session_id)
    run = {
        "session_id": session_id,
        "done": b.threading.Event(),
        "settled": b.threading.Event(),
        "stop_decided": b.threading.Event(),
        "stop_confirmed": False,
    }
    with b.TASK_CONDITION:
        b.ACTIVE_RUN = run
    driver_started.set()
    assert release_driver.wait(2), "fake driver should be released by Stop"
    run["done"].set()
    return -1, "", "driver stopped"


b.run_aside = blocking_driver
b.subprocess.run = lambda argv, **kwargs: (
    release_driver.set() or type(
        "Stopped", (), {"returncode": 0, "stdout": "", "stderr": ""})()
)
b.enqueue_task(("msg", "active prompt"))
b.enqueue_task(("cmd", "/usage"))
b.enqueue_task(("msg", "must be cancelled"))
b.enqueue_task(("msg", "also cancelled"))
worker = b.threading.Thread(target=b.worker_loop, daemon=True)
worker.start()
assert driver_started.wait(2), "worker should start the active prompt"
b.state["pending"] = "active prompt"
# A selection change during the run must not redirect Stop.
b.state["session_id"] = "newly-selected-session"
b.handle_command("/stop@samplebot")
assert finished.wait(2), "stopped message path should finish"
assert usage_handled.wait(2), "queued command should be preserved and run"
assert driver_sessions == ["driver-session"]
assert b.state["pending"] is None
assert b.TASKS.empty()
assert any("task stopped; partial output above" in message for message in TEXTS)
partial_index = next(i for i, message in enumerate(TEXTS)
                     if "partial transcript output" in message)
stopped_index = next(i for i, message in enumerate(TEXTS)
                     if "task stopped; partial output above" in message)
assert partial_index < stopped_index
assert any("cancelled 2 waiting message(s)" in message for message in TEXTS)
deadline = b.time.monotonic() + 2
while b.WORKER_BUSY.is_set() and b.time.monotonic() < deadline:
    b.time.sleep(0.01)
assert b.WORKER_BUSY.is_set() is False

print("PASS /stop targets the active run, keeps commands, cancels queued messages")
print("PASS failed, timed-out, idle, bootstrap, malformed, repeated, and naturally finished Stop paths preserve state")
print("PASS confirmed Stop terminates only a stuck bridge-owned CLI child")
print("PASS successful Stop retains partial output and prevents replay or queued restart")
os.environ.pop("ASIDE_BRIDGE_CONFIG", None)
os.environ.pop("ASIDE_BRIDGE_STATE", None)
TMP.cleanup()
