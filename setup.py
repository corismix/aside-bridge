#!/usr/bin/env python3
"""Interactive setup wizard for aside-telegram-bridge.

Run:  python3 setup.py

Walks you through everything: bot token, chat id (auto-detected by
texting your bot), style, service install. Idempotent -- safe to
re-run any time to reconfigure.
"""
import json
import os
import plistlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BRIDGE_DIR = os.path.dirname(os.path.realpath(__file__))
CONFIG_PATH = os.path.join(BRIDGE_DIR, "config.json")
EXAMPLE_PATH = os.path.join(BRIDGE_DIR, "config.example.json")
BRIDGE_PY = os.path.join(BRIDGE_DIR, "bridge.py")
LABEL = "com.aside.telegram-bridge"
PLIST_PATH = os.path.expanduser(
    "~/Library/LaunchAgents/%s.plist" % LABEL)

BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"


def say(msg=""):
    print(msg)


def ok(msg):
    print("%s  ✓ %s%s" % (GREEN, msg, RESET))


def warn(msg):
    print("%s  ! %s%s" % (YELLOW, msg, RESET))


def fail(msg):
    print("%s  ✗ %s%s" % (RED, msg, RESET))


def ask(prompt, default=None):
    suffix = " [%s]" % default if default else ""
    try:
        v = input("%s%s%s%s: " % (BOLD, prompt, suffix, RESET)).strip()
    except (EOFError, KeyboardInterrupt):
        say("\nsetup cancelled.")
        sys.exit(1)
    return v or (default or "")


def tg(token, method, params=None, timeout=30):
    data = urllib.parse.urlencode(params or {}).encode()
    req = urllib.request.Request(
        "https://api.telegram.org/bot%s/%s" % (token, method), data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def step_checks():
    say("%s— Checking your machine —%s" % (BOLD, RESET))
    if sys.platform != "darwin":
        fail("this installer supports macOS only (launchd). "
             "The bridge itself is portable -- PRs welcome.")
        sys.exit(1)
    ok("macOS")
    if sys.version_info < (3, 9):
        fail("Python 3.9+ required (you have %d.%d)"
             % sys.version_info[:2])
        sys.exit(1)
    ok("Python %d.%d" % sys.version_info[:2])

    cli = os.path.expanduser(
        "~/.aside/cli/Aside CLI.app/Contents/MacOS/aside")
    if not os.path.exists(cli):
        warn("Aside CLI not found at the default path.")
        say("    Install Aside from https://aside.so first, or enter a")
        say("    custom path if yours lives elsewhere.")
        custom = ask("  Path to the aside CLI (blank to abort)")
        if not custom or not os.path.exists(os.path.expanduser(custom)):
            fail("can't continue without the Aside CLI")
            sys.exit(1)
        cli = os.path.expanduser(custom)
    ok("Aside CLI found")
    return cli


def step_token():
    say("")
    say("%s— Step 1 of 3: your Telegram bot —%s" % (BOLD, RESET))
    say("  1. Open Telegram and message %s@BotFather%s" % (BOLD, RESET))
    say("  2. Send %s/newbot%s and follow the prompts" % (BOLD, RESET))
    say("  3. Copy the token it gives you (looks like 123456:ABC-...)")
    say("")
    while True:
        token = ask("  Paste your bot token")
        if not re.match(r"^\d+:[\w-]{20,}$", token):
            warn("that doesn't look like a bot token, try again")
            continue
        try:
            me = tg(token, "getMe")
        except Exception:
            me = {}
        if me.get("ok"):
            bot = me["result"]
            ok("connected to @%s" % bot.get("username", "?"))
            return token, bot
        warn("Telegram rejected that token, double-check and try again")


def step_chat_id(token, bot):
    say("")
    say("%s— Step 2 of 3: link your account —%s" % (BOLD, RESET))
    say("  Open a chat with %s@%s%s in Telegram and send it any"
        % (BOLD, bot.get("username", "your bot"), RESET))
    say("  message (e.g. \"hello\"). I'll detect it automatically...")
    say("")
    # drain old updates first so we only react to a fresh message
    offset = 0
    try:
        r = tg(token, "getUpdates", {"timeout": 0})
        if r.get("result"):
            offset = r["result"][-1]["update_id"] + 1
    except Exception:
        pass
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            r = tg(token, "getUpdates",
                   {"timeout": 25, "offset": offset}, timeout=35)
        except Exception:
            time.sleep(2)
            continue
        for u in r.get("result", []):
            offset = u["update_id"] + 1
            m = u.get("message") or {}
            chat = m.get("chat") or {}
            if chat.get("type") == "private" and m.get("text"):
                name = (m.get("from") or {}).get("first_name", "there")
                ok("got it -- hi %s! (chat id %s)" % (name, chat["id"]))
                return chat["id"], name
    fail("no message received in 5 minutes; re-run setup to try again")
    sys.exit(1)


def step_preferences(detected_name):
    say("")
    say("%s— Step 3 of 3: preferences —%s" % (BOLD, RESET))
    name = ask("  What should the agent call you", detected_name)
    say("")
    say("  Reply style:")
    say("    1. formal  -- clear, professional texting (default)")
    say("    2. casual  -- lowercase, dry wit, texting slang")
    style = "casual" if ask("  Pick 1 or 2", "1").strip() == "2" \
        else "formal"
    ok("style: %s" % style)
    return name, style


def write_config(token, chat_id, name, style, cli):
    cfg = {}
    for path in (CONFIG_PATH, EXAMPLE_PATH):
        if os.path.exists(path):
            try:
                with open(path) as f:
                    cfg = json.load(f)
                break
            except ValueError:
                pass
    cfg.update({
        "token": token,
        "chat_id": chat_id,
        "owner_name": name,
        "style": style,
        "aside_cli": cli,
    })
    cfg.setdefault("default_model", "claude-sonnet-5")
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)
    ok("config.json written (chmod 600 -- keep it private)")


def register_bot_commands(token):
    cmds = [
        {"command": "status", "description": "model, session, queue"},
        {"command": "usage", "description": "usage + context fill"},
        {"command": "model", "description": "switch model"},
        {"command": "effort", "description": "pick thinking effort"},
        {"command": "new", "description": "fresh session"},
        {"command": "sessions", "description": "list/switch sessions"},
    ]
    try:
        tg(token, "setMyCommands", {"commands": json.dumps(cmds)})
        ok("bot command menu registered")
    except Exception:
        warn("couldn't register the command menu (cosmetic, skipping)")


def install_service():
    say("")
    say("%s— Installing the background service —%s" % (BOLD, RESET))
    plist = {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", BRIDGE_PY],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": os.path.join(BRIDGE_DIR, "launchd.out.log"),
        "StandardErrorPath": os.path.join(BRIDGE_DIR, "launchd.err.log"),
    }
    os.makedirs(os.path.dirname(PLIST_PATH), exist_ok=True)
    target = "gui/%d/%s" % (os.getuid(), LABEL)
    subprocess.run(["launchctl", "bootout", target],
                   capture_output=True)
    with open(PLIST_PATH, "wb") as f:
        plistlib.dump(plist, f)
    r = subprocess.run(
        ["launchctl", "bootstrap", "gui/%d" % os.getuid(), PLIST_PATH],
        capture_output=True, text=True)
    if r.returncode != 0:
        fail("launchctl bootstrap failed: %s" % (r.stderr or r.stdout))
        say("  You can start it manually with: python3 bridge.py")
        return False
    ok("service installed (starts on login, restarts on crash)")

    # bless this bridge.py as known-good for `bridgemon update` rollbacks
    try:
        subprocess.run(
            [sys.executable, os.path.join(BRIDGE_DIR, "bridgemon.py"),
             "init"], capture_output=True, timeout=15)
    except Exception:
        pass

    # health check: process alive after a few seconds?
    time.sleep(4)
    chk = subprocess.run(["launchctl", "print", target],
                         capture_output=True, text=True)
    if chk.returncode == 0 and "pid = " in chk.stdout:
        ok("bridge is running")
        return True
    warn("service installed but not confirmed running yet; "
         "check launchd.err.log if the bot doesn't answer")
    return True


def offer_bridgemon():
    bin_dir = os.path.expanduser("~/bin")
    link = os.path.join(bin_dir, "bridgemon")
    v = ask("\n  Add the `bridgemon` command to ~/bin? (y/n)", "y")
    if v.lower().startswith("n"):
        return
    os.makedirs(bin_dir, exist_ok=True)
    try:
        if os.path.islink(link) or os.path.exists(link):
            os.remove(link)
        os.symlink(os.path.join(BRIDGE_DIR, "bridgemon.py"), link)
        ok("linked ~/bin/bridgemon (make sure ~/bin is on your PATH)")
    except OSError as e:
        warn("couldn't create the symlink: %s" % e)


def offer_miniapp():
    """Hand off to the Mini App wizard, if this tree has one.

    Deliberately a separate script rather than more steps here: the Mini
    App needs Node, builds a web app, and installs a second launchd
    service, and none of that should be able to fail the bridge install
    that just succeeded. Declining leaves a working bridge, and
    `python3 miniapp/setup-miniapp.py` runs the same thing later.
    """
    wizard = os.path.join(BRIDGE_DIR, "miniapp", "setup-miniapp.py")
    if not os.path.exists(wizard):
        return

    say("")
    say("%s— Optional: the Aside Mini App —%s" % (BOLD, RESET))
    say("  The full Aside UI inside Telegram: sessions, live transcripts,")
    say("  subagents, files, permissions -- opened from the menu button")
    say("  next to the message box. Same bot, same allowlist.")
    say("  %sNeeds Node 20+. Takes a couple of minutes to build.%s"
        % (DIM, RESET))
    if not ask("  Set up the Aside Mini App now? (y/n)",
               "y").lower().startswith("y"):
        say("  %sSkipped. Run it any time:"
            " python3 miniapp/setup-miniapp.py%s" % (DIM, RESET))
        return

    env = dict(os.environ, MINIAPP_CONFIG=CONFIG_PATH)
    r = subprocess.run([sys.executable, wizard], env=env)
    if r.returncode != 0:
        warn("the Mini App setup did not finish -- the bridge is fine.")
        say("  %sRe-run it with: python3 miniapp/setup-miniapp.py%s"
            % (DIM, RESET))


def main():
    say("")
    say("%s┌─────────────────────────────────────┐%s" % (BOLD, RESET))
    say("%s│  aside-telegram-bridge setup wizard │%s" % (BOLD, RESET))
    say("%s└─────────────────────────────────────┘%s" % (BOLD, RESET))
    say("%s  Text your Aside agent from your phone. ~2 minutes.%s"
        % (DIM, RESET))
    say("")
    if os.path.exists(CONFIG_PATH):
        warn("existing config.json found -- re-running setup will "
             "overwrite token/chat/style (other settings are kept)")
        if ask("  Continue? (y/n)", "y").lower().startswith("n"):
            sys.exit(0)

    cli = step_checks()
    token, bot = step_token()
    chat_id, detected_name = step_chat_id(token, bot)
    name, style = step_preferences(detected_name)
    write_config(token, chat_id, name, style, cli)
    register_bot_commands(token)
    started = install_service()
    offer_bridgemon()

    say("")
    say("%s— Done! —%s" % (BOLD, RESET))
    if started:
        say("  Text %s@%s%s anything. First reply takes ~30s while it"
            % (BOLD, bot.get("username", "your bot"), RESET))
        say("  creates and primes your agent session; after that it's"
            " fast.")
    say("  Useful commands: /status /usage /model /sessions /new")
    say("  Monitor or stop any time: bridgemon watch")
    say("")


if __name__ == "__main__":
    main()
