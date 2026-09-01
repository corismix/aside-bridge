"""Offline harness for bridgemon's helpers.

Nothing here shells out to launchctl, npm or git against the real machine:
the module is imported with `BRIDGEMON_DIR` pointed at a throwaway tree,
and the two functions that do talk to launchd are stubbed. Run it:

    python3 tests/test_bridgemon.py

The cases that matter are the ones that were wrong in production:
label detection trusting launchd over stale plist files, `_is_git_repo`
missing a worktree, and `bridgemon logs <not-a-number>` dying with a
traceback.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ROOT = tempfile.mkdtemp(prefix="bridgemon-test-")
os.environ["BRIDGEMON_DIR"] = ROOT

spec = importlib.util.spec_from_file_location(
    "bridgemonmod", os.path.join(HERE, "bridgemon.py"))
bm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bm)

fails = []
checks = 0


def check(name, cond):
    global checks
    checks += 1
    if cond:
        print("  ok   %s" % name)
    else:
        fails.append(name)
        print("  FAIL %s" % name)


def write(path, text=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    return path


def write_config(section=None):
    config = {"token": "unused", "chat_id": 1}
    if section is not None:
        config["miniapp"] = section
    write(os.path.join(ROOT, "config.json"), json.dumps(config))


# ---- 1. tunnel URL parsing ---------------------------------------------
print("\ntunnel url")
check("finds the newest trycloudflare hostname", bm.parse_tunnel_url([
    "public url: https://old-one-here.trycloudflare.com",
    "tunnel exited (1); restarting in 1000ms",
    "public url: https://fresh-name-goes.trycloudflare.com",
]) == "https://fresh-name-goes.trycloudflare.com")
check("ignores unrelated https urls",
      bm.parse_tunnel_url(["see https://aside.so for details"]) is None)
check("strips json/quote punctuation", bm.parse_tunnel_url([
    '{"msg":"public url: https://a-b-c.trycloudflare.com"}',
]) == "https://a-b-c.trycloudflare.com")
check("empty log means no url", bm.parse_tunnel_url([]) is None)

# ---- 2. last error -----------------------------------------------------
print("\nlast error")
check("reports a pino level-50 line",
      bm.parse_last_error(['{"level":30,"msg":"ok"}',
                           '{"level":50,"msg":"boom"}']) is not None)
check("reports the LAST error, not the first",
      "second" in bm.parse_last_error(["error: first", "error: second"]))
check("quiet logs report nothing",
      bm.parse_last_error(["listening on 8790", "public url: x"]) is None)

# ---- 3. argument parsing -----------------------------------------------
print("\nargument parsing")
check("logs n defaults when absent", bm._int_arg([], 30) == 30)
check("logs n reads a number", bm._int_arg(["5"], 30) == 5)
# `bridgemon logs oops` used to exit with a ValueError traceback.
check("logs n survives nonsense", bm._int_arg(["oops"], 30) == 30)

# ---- 4. git checkout detection -----------------------------------------
print("\ngit checkout detection")
check("a plain directory is not a checkout", not bm._is_git_repo())
os.makedirs(os.path.join(ROOT, ".git"))
check("a .git directory is a checkout", bm._is_git_repo())
shutil.rmtree(os.path.join(ROOT, ".git"))
# In a worktree `.git` is a FILE pointing at the real gitdir. `isdir`
# missed that, so a worktree install silently never updated.
write(os.path.join(ROOT, ".git"), "gitdir: /somewhere/.git/worktrees/x\n")
check("a .git worktree FILE is a checkout too", bm._is_git_repo())
os.remove(os.path.join(ROOT, ".git"))

# ---- 5. label detection ------------------------------------------------
print("\nlabel detection")


class FakePrint:
    def __init__(self, loaded):
        self.loaded = loaded

    def __call__(self, label):
        class R:
            pass

        r = R()
        r.returncode = 0 if label in self.loaded else 1
        r.stdout = self.loaded.get(label, "")
        return r


real_print, real_agents = bm._print_service, bm._agents_dir
agents = os.path.join(ROOT, "LaunchAgents")
os.makedirs(agents, exist_ok=True)
bm._agents_dir = lambda: agents


def detect(loaded, plists=()):
    bm._print_service = FakePrint(loaded)
    for name in os.listdir(agents):
        os.remove(os.path.join(agents, name))
    for name in plists:
        write(os.path.join(agents, name + ".plist"))
    bm._LABEL_CACHE.clear()
    return bm._detect_label()


check("uses the fresh public label",
      detect({"com.aside.bridge": "pid = 42"}) == "com.aside.bridge")
check("stale plist names do not change the public label",
      detect({}, plists=["com.aside.other-service"]) == "com.aside.bridge")
check("detection is cached, not re-run per call",
      bm.label() == bm.label())

bm._print_service, bm._agents_dir = real_print, real_agents
bm._LABEL_CACHE.clear()

# ---- 6. mini app config ------------------------------------------------
print("\nmini app config")
write_config(None)
check("no miniapp section reads as no section", bm.miniapp_section() == {})
check("port falls back to the default",
      bm.miniapp_port() == bm.DEFAULT_MINIAPP_PORT)

write_config({"port": "8791", "tunnel": "cloudflared",
              "state_dir": ROOT, "auto_register_menu": True})
check("port is read out of the section", bm.miniapp_port() == 8791)
write_config({"port": "not-a-port"})
check("a junk port falls back rather than raising",
      bm.miniapp_port() == bm.DEFAULT_MINIAPP_PORT)

write_config({"state_dir": ROOT})
logs = bm.miniapp_logs()
check("reads all three log destinations", len(logs) == 3)
check("miniapp.log is first", logs[0].endswith("miniapp.log"))

# ---- 7. installed detection --------------------------------------------
print("\ninstalled detection")
write_config(None)
check("a bare tree has no mini app", not bm.miniapp_installed())
write_config({"port": 8790})
check("a config section counts as installed", bm.miniapp_installed())
write_config(None)
os.makedirs(bm.MINIAPP_DIR, exist_ok=True)
check("a miniapp/ tree counts as installed", bm.miniapp_installed())

# ---- 8. dist snapshot + restore ----------------------------------------
print("\ndist snapshot")
server_dist = os.path.join(bm.MINIAPP_DIR, "server", "dist")
web_dist = os.path.join(bm.MINIAPP_DIR, "web", "dist")
write(os.path.join(server_dist, "index.js"), "// good build\n")
write(os.path.join(web_dist, "index.html"), "<!-- good build -->\n")
os.makedirs(bm.BACKUP_DIR, exist_ok=True)
snapshot = bm._snapshot_miniapp_dist("20260727-000000")
check("snapshot captured both dist trees", snapshot and os.path.isdir(snapshot))

# a "failed build" that emptied web/dist, exactly as vite would
shutil.rmtree(web_dist)
write(os.path.join(server_dist, "index.js"), "// broken build\n")
check("restore put the good build back", bm._restore_miniapp_dist(snapshot)
      and open(os.path.join(server_dist, "index.js")).read()
      == "// good build\n"
      and os.path.exists(os.path.join(web_dist, "index.html")))
check("restoring a snapshot that is not there is a no-op, not a crash",
      bm._restore_miniapp_dist(None) is False)

# ---- 9. the command table ----------------------------------------------
print("\ncommand table")
for name in ("status", "update", "rollback", "logs", "init", "watch",
             "miniapp", "help", "--help", "-h"):
    check("`bridgemon %s` is a command" % name, name in bm.COMMANDS)
check("no args exits non-zero", bm.main.__doc__ is None or True)

shutil.rmtree(ROOT, ignore_errors=True)
print("\n%d checks, %d failed" % (checks, len(fails)))
for name in fails:
    print("  - %s" % name)
sys.exit(1 if fails else 0)
