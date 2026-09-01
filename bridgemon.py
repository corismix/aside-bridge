#!/usr/bin/env python3
"""bridgemon -- single CLI for the Aside <-> Telegram bridge + Mini App.

Deploy tooling:
  bridgemon status          both services: launchd state, pid, port,
                             tunnel URL, last log lines
  bridgemon update          git pull (if this is a repo clone), then
                             syntax-check, restart, health-check, and
                             keep or auto-rollback bridge.py. When the
                             Mini App is installed it is rebuilt and
                             restarted too, with the same rollback rule.
  bridgemon rollback        force-restore the last known-good bridge.py
  bridgemon logs [n]        tail last n lines of bridge.log (default 30)
  bridgemon init            bless the current bridge.py as known-good
                             without restarting (first-time setup)

Mini App (the Telegram Mini App UI, if installed):
  bridgemon miniapp status  running state, pid, port, tunnel URL
  bridgemon miniapp start | stop | restart
  bridgemon miniapp logs [n]

Live monitor (delegates to monitor.py, same as before):
  bridgemon watch           merged live timeline + interactive kill switch
  bridgemon watch --status  snapshot and exit
  bridgemon watch --kill    stop the bridge + any in-flight turn
  bridgemon watch --start   start the bridge

  bridgemon help            this text

Exit codes: 0 success, 1 failure (update rolled back, or command error).
"""
import json
import os
import py_compile
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

#: The install being managed. Normally the directory this file sits in.
#: `BRIDGEMON_DIR` points it elsewhere, which is what lets a checkout
#: report on (or update) a deployment installed under ~/.aside, and what
#: lets the tests run against a throwaway tree instead of the real one.
BRIDGE_DIR = os.path.expanduser(
    os.environ.get("BRIDGEMON_DIR")
    or os.path.dirname(os.path.realpath(__file__)))
BRIDGE_PY = os.path.join(BRIDGE_DIR, "bridge.py")
LOG_PATH = os.path.join(BRIDGE_DIR, "bridge.log")
ERR_LOG_PATH = os.path.join(BRIDGE_DIR, "launchd.err.log")
BACKUP_DIR = os.path.join(BRIDGE_DIR, "backups")
LAST_GOOD = os.path.join(BACKUP_DIR, "last-good.py")

MINIAPP_DIR = os.path.join(BRIDGE_DIR, "miniapp")
MINIAPP_LABEL = "com.aside.miniapp"
DEFAULT_CONFIG = os.path.join(BRIDGE_DIR, "config.json")
DEFAULT_MINIAPP_PORT = 8790


def _uid():
    return os.getuid()


def _agents_dir():
    return os.path.expanduser("~/Library/LaunchAgents")


def plist_path(label):
    return os.path.join(_agents_dir(), label + ".plist")


def _print_service(label):
    """Raw `launchctl print` for a label. Empty stdout means not loaded."""
    return subprocess.run(
        ["launchctl", "print", "gui/%d/%s" % (_uid(), label)],
        capture_output=True, text=True)


def label_is_loaded(label):
    """True only if launchd actually knows about this label right
    now -- a plist *file* existing on disk means nothing if it was
    never bootstrapped (or was later booted out), which is exactly
    what caused a false 'not running' / bad auto-rollback before."""
    return _print_service(label).returncode == 0


BRIDGE_LABEL = "com.aside.bridge"


def _detect_label():
    """Return the launchd label used by this fresh installation."""
    return BRIDGE_LABEL


_LABEL_CACHE = []


def label():
    """The bridge's launchd label, detected once per process.

    Deliberately lazy rather than computed at import: detection shells
    out to `launchctl print` up to four times, and `bridgemon logs` --
    and anything that merely imports this module, such as monitor.py --
    has no business paying for that.
    """
    if not _LABEL_CACHE:
        _LABEL_CACHE.append(_detect_label())
    return _LABEL_CACHE[0]


HEALTH_WAIT_S = 6
HEALTH_POLL_S = 1.5


def _launchctl(*args):
    return subprocess.run(
        ["launchctl", *args], capture_output=True, text=True
    )


def _service_target(lbl=None):
    return "gui/%d/%s" % (_uid(), lbl or label())


def service_state(lbl):
    """(loaded, pid) for a label, read out of launchd's live registry."""
    r = _print_service(lbl)
    if r.returncode != 0:
        return False, None
    pid = None
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("pid ="):
            pid = line.split("=")[1].strip()
    return True, pid


def is_running(lbl=None):
    loaded, pid = service_state(lbl or label())
    return (loaded and pid is not None), pid


def tail(path, n=30):
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        block = 4096
        data = b""
        while size > 0 and data.count(b"\n") <= n:
            step = min(block, size)
            size -= step
            f.seek(size)
            data = f.read(step) + data
    return data.decode("utf-8", "replace").splitlines()[-n:]


def kickstart_restart(lbl=None):
    _launchctl("kickstart", "-k", _service_target(lbl))


# --- Mini App ------------------------------------------------------------
#
# The Mini App is optional: a bridge install that never ran
# miniapp/setup-miniapp.py has no `miniapp` config section, no
# com.aside.miniapp plist and possibly no miniapp/ directory at all.
# Every function below has to read as "not installed" in that case rather
# than as "broken", which is why they all degrade to None/False instead of
# raising.


def config_path():
    """Where the bridge config lives.

    Normally next to this file. `BRIDGEMON_CONFIG` overrides it, which is
    what lets a checkout report on a deployment installed elsewhere -- and
    what lets the tests point at a throwaway config instead of the
    owner's.
    """
    return os.path.expanduser(os.environ.get("BRIDGEMON_CONFIG")
                              or DEFAULT_CONFIG)


def read_config(path=None):
    """The bridge's config.json, or {} if it isn't readable."""
    try:
        with open(path or config_path()) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def miniapp_section(config=None):
    section = (config if config is not None else read_config()).get("miniapp")
    return section if isinstance(section, dict) else {}


def miniapp_installed():
    """Whether there is a Mini App here to manage at all.

    Any one of a config section, a launchd plist or a built tree counts:
    they come from the same setup run but can outlive each other (a
    booted-out service still has its config; a fresh clone has the tree
    but no config yet).
    """
    return bool(
        miniapp_section()
        or os.path.exists(plist_path(MINIAPP_LABEL))
        or os.path.isdir(MINIAPP_DIR)
    )


def miniapp_port(section=None):
    section = miniapp_section() if section is None else section
    try:
        return int(section.get("port", DEFAULT_MINIAPP_PORT))
    except (TypeError, ValueError):
        return DEFAULT_MINIAPP_PORT


def miniapp_state_dir(section=None):
    section = miniapp_section() if section is None else section
    return os.path.expanduser(
        str(section.get("state_dir") or os.path.dirname(config_path())))


def miniapp_logs(section=None):
    """Every file the Mini App's output can land in, newest info last.

    setup-miniapp.py points launchd's stdout/stderr at
    `miniapp.out.log` / `miniapp.err.log`, and the server's own rotating
    log is `miniapp.log`. The tunnel URL has appeared in all three
    depending on how the process was started, so all three are read.
    """
    section = miniapp_section() if section is None else section
    state_dir = miniapp_state_dir(section)
    configured = section.get("log_path")
    paths = [
        os.path.expanduser(str(configured)) if configured
        else os.path.join(state_dir, "miniapp.log"),
        os.path.join(state_dir, "miniapp.out.log"),
        os.path.join(state_dir, "miniapp.err.log"),
    ]
    seen, out = set(), []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def parse_tunnel_url(lines):
    """The most recent trycloudflare hostname in some log lines."""
    for line in reversed(lines):
        at = line.find("https://")
        if at == -1:
            continue
        # The URL is banner text in one log and a JSON string value in
        # another, so trailing quoting/bracketing comes off either way.
        url = line[at:].split()[0].rstrip('"\'.,;:)]}')
        if "trycloudflare.com" in url:
            return url
    return None


def parse_last_error(lines):
    """The most recent line that reads like a failure, or None."""
    for line in reversed(lines):
        low = line.lower()
        if '"level":50' in line or '"level":60' in line:
            return line.strip()
        if any(mark in low for mark in
               ("error", "traceback", "failed", "exception")):
            return line.strip()
    return None


def miniapp_health(port, timeout=2):
    """True if /api/health answers ok on loopback. Read-only."""
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d/api/health" % port, timeout=timeout) as r:
            return bool(json.load(r).get("ok"))
    except (urllib.error.URLError, OSError, ValueError):
        return False


def miniapp_status():
    """Everything `status` reports about the Mini App, gathered read-only."""
    section = miniapp_section()
    loaded, pid = service_state(MINIAPP_LABEL)
    port = miniapp_port(section)
    logs = miniapp_logs(section)
    lines = []
    for path in logs:
        lines.extend(tail(path, 200))
    # "waiting…" is only honest if there is a log to wait on. A server
    # started by hand logs to its terminal, and reporting that as
    # "waiting" would be reporting a guess as a state.
    if section.get("tunnel") != "cloudflared":
        tunnel_note = "off"
    elif any(os.path.exists(p) for p in logs):
        tunnel_note = "waiting…"
    else:
        tunnel_note = "unknown (no mini app log at %s)" % logs[0]
    return {
        "tunnel_note": tunnel_note,
        "installed": miniapp_installed(),
        "label": MINIAPP_LABEL,
        "service_loaded": loaded,
        "plist": os.path.exists(plist_path(MINIAPP_LABEL)),
        "pid": pid,
        "port": port,
        "healthy": miniapp_health(port),
        "tunnel": parse_tunnel_url(lines),
        "last_error": parse_last_error(lines),
        "tunnel_mode": section.get("tunnel", "none"),
        "auto_register_menu": bool(section.get("auto_register_menu")),
    }


def _npm():
    npm = shutil.which("npm")
    if npm:
        return npm
    # launchd-style minimal PATH is not this process's problem, but a
    # login shell that never picked up Homebrew is a common one.
    for candidate in ("/opt/homebrew/bin/npm", "/usr/local/bin/npm"):
        if os.path.exists(candidate):
            return candidate
    return None


def _miniapp_dist_dirs():
    return [
        os.path.join(MINIAPP_DIR, "server", "dist"),
        os.path.join(MINIAPP_DIR, "web", "dist"),
    ]


def _snapshot_miniapp_dist(stamp):
    """Copy the built output aside so a failed build can be undone.

    Same discipline as `last-good.py` for the bridge: a build that fails
    halfway has already emptied `web/dist` (vite clears its outDir), so
    without this a broken update would leave the service serving nothing
    and there would be nothing to put back.
    """
    dest = os.path.join(BACKUP_DIR, "miniapp-dist-%s" % stamp)
    saved = []
    for src in _miniapp_dist_dirs():
        if not os.path.isdir(src):
            continue
        target = os.path.join(dest, os.path.relpath(src, MINIAPP_DIR))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copytree(src, target)
        saved.append((src, target))
    return dest if saved else None


def _restore_miniapp_dist(snapshot):
    if not snapshot or not os.path.isdir(snapshot):
        return False
    for src in _miniapp_dist_dirs():
        saved = os.path.join(snapshot, os.path.relpath(src, MINIAPP_DIR))
        if not os.path.isdir(saved):
            continue
        shutil.rmtree(src, ignore_errors=True)
        shutil.copytree(saved, src)
    return True


def _prune_miniapp_snapshots(keep=3):
    try:
        snaps = sorted(
            f for f in os.listdir(BACKUP_DIR)
            if f.startswith("miniapp-dist-")
        )
    except OSError:
        return
    for f in snaps[:-keep]:
        shutil.rmtree(os.path.join(BACKUP_DIR, f), ignore_errors=True)


def _miniapp_build():
    """`npm install && npm run build` in miniapp/. Returns (ok, message)."""
    npm = _npm()
    if not npm:
        return False, "npm not found on PATH -- install Node 20+ first"
    for args in (["install"], ["run", "build"]):
        print("  npm %s..." % " ".join(args))
        proc = subprocess.run([npm, *args], cwd=MINIAPP_DIR)
        if proc.returncode != 0:
            return False, "`npm %s` failed" % " ".join(args)
    return True, "built"


def _miniapp_wait_healthy(port, attempts=15):
    for _ in range(attempts):
        if miniapp_health(port):
            return True
        time.sleep(1)
    return False


def cmd_miniapp(args):
    sub = args[0] if args else "status"
    if not miniapp_installed():
        print("no Mini App here -- run: python3 miniapp/setup-miniapp.py")
        return 1

    if sub == "status":
        _print_miniapp_status(miniapp_status())
        return 0

    if sub == "logs":
        n = _int_arg(args[1:], 30)
        for path in miniapp_logs():
            lines = tail(path, n)
            if not lines:
                continue
            print("--- %s" % path)
            for line in lines:
                print(line)
        return 0

    if sub in ("start", "stop", "restart"):
        if not os.path.exists(plist_path(MINIAPP_LABEL)):
            print("no %s.plist installed -- run: "
                  "python3 miniapp/setup-miniapp.py" % MINIAPP_LABEL)
            return 1
        target = _service_target(MINIAPP_LABEL)
        if sub == "stop":
            _launchctl("bootout", target)
            print("mini app stopped")
            return 0
        if sub == "start":
            if label_is_loaded(MINIAPP_LABEL):
                _launchctl("kickstart", target)
            else:
                r = _launchctl("bootstrap", "gui/%d" % _uid(),
                               plist_path(MINIAPP_LABEL))
                if r.returncode != 0:
                    print("launchctl bootstrap failed: %s"
                          % (r.stderr or r.stdout).strip()[:200])
                    return 1
        else:
            kickstart_restart(MINIAPP_LABEL)
        healthy = _miniapp_wait_healthy(miniapp_port())
        print("mini app %s; health check %s"
              % (sub + "ed" if sub == "start" else "restarted",
                 "ok" if healthy else "FAILED"))
        return 0 if healthy else 1

    print("unknown: bridgemon miniapp %s" % sub)
    print("try: status | start | stop | restart | logs [n]")
    return 1


def _print_miniapp_status(info):
    if not info["installed"]:
        print("mini app: not installed "
              "(python3 miniapp/setup-miniapp.py to add it)")
        return
    print("mini app service: %s" % info["label"])
    if info["service_loaded"]:
        state = "loaded%s" % (" (pid %s)" % info["pid"] if info["pid"] else "")
    elif info["plist"]:
        state = "installed but not loaded"
    else:
        state = "no launchd plist (started by hand?)"
    print("running:  %s" % state)
    print("port:     %d (health %s)"
          % (info["port"], "ok" if info["healthy"] else "no answer"))
    print("tunnel:   %s" % (info["tunnel"] or info["tunnel_note"]))
    print("menu button auto-register: %s"
          % ("on" if info["auto_register_menu"] else "off"))
    if info["last_error"]:
        print("last error: %s" % info["last_error"][:200])


def cmd_status(_args):
    running, pid = is_running()
    print("bridge service: %s" % label())
    print("running:  %s%s" % (running, (" (pid %s)" % pid) if pid else ""))
    print("last-good backup: %s"
          % ("yes" if os.path.exists(LAST_GOOD) else "none yet"))
    print()
    _print_miniapp_status(miniapp_status())
    print()
    print("last log lines:")
    for line in tail(LOG_PATH, 8):
        print("  " + line)
    return 0


def _int_arg(args, default):
    """First arg as an int, or the default. `bridgemon logs oops` used to
    die with a ValueError traceback."""
    if not args:
        return default
    try:
        return int(args[0])
    except (TypeError, ValueError):
        return default


def cmd_logs(args):
    for line in tail(LOG_PATH, _int_arg(args, 30)):
        print(line)
    return 0


def cmd_init(_args):
    if not os.path.exists(BRIDGE_PY):
        print("bridge.py not found, nothing to bless")
        return 1
    os.makedirs(BACKUP_DIR, exist_ok=True)
    shutil.copy2(BRIDGE_PY, LAST_GOOD)
    print("blessed current bridge.py as known-good (no restart done)")
    return 0


def cmd_help(_args):
    print(__doc__)
    return 0


def _syntax_check():
    try:
        py_compile.compile(BRIDGE_PY, doraise=True)
        return True, ""
    except py_compile.PyCompileError as e:
        return False, str(e)


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _read_from(path, offset):
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _health_check():
    """Poll for HEALTH_WAIT_S seconds. Healthy if the process is up,
    bridge.log shows a fresh 'bridge starting' line, and no traceback
    was appended to the err log -- both measured from byte offsets
    captured at call time, so stale pre-restart log content (e.g. a
    traceback from a *previous* failed attempt) never causes a false
    positive."""
    log_offset = _size(LOG_PATH)
    err_offset = _size(ERR_LOG_PATH)
    deadline = time.time() + HEALTH_WAIT_S
    saw_start = False
    while time.time() < deadline:
        time.sleep(HEALTH_POLL_S)
        running, _ = is_running()
        if not running:
            return False, "process not running after restart"
        if "bridge starting" in _read_from(LOG_PATH, log_offset):
            saw_start = True
        new_err = _read_from(ERR_LOG_PATH, err_offset)
        if "Traceback (most recent call last)" in new_err:
            return False, "new traceback in launchd.err.log after restart"
    if not saw_start:
        return False, "never saw a fresh 'bridge starting' log line"
    return True, "ok"


def _is_git_repo():
    """A checkout, including a worktree.

    `isdir` was wrong: in a git worktree `.git` is a FILE pointing at the
    real gitdir, so a worktree install silently took the "local-only mode"
    path and never updated.
    """
    return os.path.exists(os.path.join(BRIDGE_DIR, ".git"))


def _git(*args):
    return subprocess.run(
        ["git", "-C", BRIDGE_DIR, *args], capture_output=True, text=True
    )


def _git_dirty():
    """True if any *tracked* file has uncommitted changes (staged or
    not). Ignores untracked files (config.json etc. are gitignored
    anyway)."""
    r = _git("status", "--porcelain", "--untracked-files=no")
    return bool(r.stdout.strip())


def _git_pull():
    """Pull the tracked branch if this directory is a clone of the repo.
    Returns (changed, message). Refuses to touch anything if there are
    uncommitted local edits to tracked files -- a hard reset would
    silently destroy them, which is worse than a stale update."""
    if not _is_git_repo():
        return False, "not a git checkout, skipping pull (local-only mode)"
    if _git_dirty():
        return False, (
            "uncommitted local changes to tracked files -- refusing to "
            "pull (would discard them). commit or stash first, then "
            "rerun update"
        )
    r = _git("rev-parse", "--abbrev-ref", "HEAD")
    branch = r.stdout.strip() or "main"
    before = _git("rev-parse", "HEAD").stdout.strip()
    fetch = _git("fetch", "origin", branch)
    if fetch.returncode != 0:
        return False, "git fetch failed: %s" % fetch.stderr.strip()[:200]
    target = "origin/%s" % branch
    remote_head = _git("rev-parse", target).stdout.strip()
    if before == remote_head:
        return False, "already up to date (%s)" % before[:8]
    # refuse a hard reset if it would discard real local commits --
    # e.g. work committed here but not yet pushed. Only fast-forward
    # (local HEAD must already be an ancestor of the remote branch).
    ff_check = _git("merge-base", "--is-ancestor", "HEAD", target)
    if ff_check.returncode != 0:
        ahead = _git("rev-list", "--count",
                     "%s..HEAD" % target).stdout.strip()
        return False, (
            "local HEAD has %s commit(s) not on %s -- refusing to "
            "reset (would discard them). push your local commits "
            "first, then rerun update" % (ahead or "some", target)
        )
    reset = _git("reset", "--hard", target)
    if reset.returncode != 0:
        return False, "git reset failed: %s" % reset.stderr.strip()[:200]
    after = _git("rev-parse", "HEAD").stdout.strip()
    return True, "pulled %s..%s" % (before[:8], after[:8])


def _update_miniapp(stamp):
    """Rebuild and restart the Mini App. Returns (ok, message).

    Same shape as the bridge path above it: snapshot what is currently
    deployed, apply, health-check, and put the snapshot back if the
    health check does not pass. A build failure never gets as far as a
    restart.
    """
    if not miniapp_installed():
        return True, "no mini app installed, nothing to rebuild"
    if not os.path.isdir(MINIAPP_DIR):
        return True, "miniapp/ not in this checkout, skipping"

    os.makedirs(BACKUP_DIR, exist_ok=True)
    snapshot = _snapshot_miniapp_dist(stamp)

    built, message = _miniapp_build()
    if not built:
        if _restore_miniapp_dist(snapshot):
            return False, "%s -- restored the previous build" % message
        return False, message

    if not os.path.exists(plist_path(MINIAPP_LABEL)):
        _prune_miniapp_snapshots()
        return True, ("rebuilt; no %s service installed, so nothing to "
                      "restart" % MINIAPP_LABEL)

    kickstart_restart(MINIAPP_LABEL)
    if _miniapp_wait_healthy(miniapp_port()):
        _prune_miniapp_snapshots()
        return True, "mini app rebuilt, restarted and healthy"

    if _restore_miniapp_dist(snapshot):
        kickstart_restart(MINIAPP_LABEL)
        healthy = _miniapp_wait_healthy(miniapp_port())
        return False, (
            "mini app unhealthy after restart -- rolled back to the "
            "previous build (%s)"
            % ("healthy again" if healthy else "still unhealthy, check logs"))
    return False, "mini app unhealthy after restart and no snapshot to restore"


def cmd_update(_args):
    pulled, pull_msg = _git_pull()
    print(pull_msg)

    if not os.path.exists(BRIDGE_PY):
        print("bridge.py not found")
        return 1

    ok, err = _syntax_check()
    if not ok:
        print("syntax check failed, not deploying:\n%s" % err)
        return 1

    os.makedirs(BACKUP_DIR, exist_ok=True)
    if not os.path.exists(LAST_GOOD):
        # first run: nothing to roll back to yet, just bless + go
        shutil.copy2(BRIDGE_PY, LAST_GOOD)

    same_as_live = (
        os.path.exists(LAST_GOOD)
        and open(BRIDGE_PY, "rb").read() == open(LAST_GOOD, "rb").read()
    )

    print("restarting bridge to apply update...")
    kickstart_restart()
    healthy, reason = _health_check()

    if not healthy:
        print("update looked unhealthy (%s) -- rolling back" % reason)
        shutil.copy2(LAST_GOOD, BRIDGE_PY)
        kickstart_restart()
        healthy2, reason2 = _health_check()
        if healthy2:
            print("rolled back to last known-good and confirmed healthy")
        else:
            print("rollback restart still unhealthy (%s) -- check logs "
                  "and the launchd job by hand" % reason2)
        # The bridge is the thing people text; a rolled-back bridge is a
        # failed update whatever the mini app then did.
        return 1

    ts = time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(BRIDGE_PY, LAST_GOOD)
    shutil.copy2(BRIDGE_PY, os.path.join(BACKUP_DIR, "bridge-%s.py" % ts))
    _prune_backups()
    if same_as_live:
        print("bridge update applied and healthy (no code change detected)")
    else:
        print("bridge update applied and healthy. snapshot saved: %s" % ts)

    mini_ok, mini_msg = _update_miniapp(ts)
    print(mini_msg)
    return 0 if mini_ok else 1


def cmd_rollback(_args):
    if not os.path.exists(LAST_GOOD):
        print("no last-good backup on file, nothing to roll back to")
        return 1
    shutil.copy2(LAST_GOOD, BRIDGE_PY)
    kickstart_restart()
    healthy, reason = _health_check()
    if healthy:
        print("rolled back to last known-good and confirmed healthy")
        return 0
    print("rolled back but health check failed (%s), check logs" % reason)
    return 1


def _prune_backups(keep=10):
    snaps = sorted(
        f for f in os.listdir(BACKUP_DIR)
        if f.startswith("bridge-") and f.endswith(".py")
    )
    for f in snaps[:-keep]:
        try:
            os.remove(os.path.join(BACKUP_DIR, f))
        except OSError:
            pass


def cmd_watch(args):
    """Delegate to the existing interactive live-monitor/kill-switch tool.
    Replaces this process so its raw-tty keybindings work normally."""
    monitor_py = os.path.join(BRIDGE_DIR, "monitor.py")
    if not os.path.exists(monitor_py):
        print("monitor.py not found next to bridgemon.py")
        return 1
    os.execvp(sys.executable, [sys.executable, monitor_py, *args])


COMMANDS = {
    "status": cmd_status,
    "update": cmd_update,
    "rollback": cmd_rollback,
    "logs": cmd_logs,
    "init": cmd_init,
    "watch": cmd_watch,
    "miniapp": cmd_miniapp,
    "help": cmd_help,
    "--help": cmd_help,
    "-h": cmd_help,
}


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    if args[0] not in COMMANDS:
        print(__doc__)
        return 1
    return COMMANDS[args[0]](args[1:])


if __name__ == "__main__":
    sys.exit(main())
