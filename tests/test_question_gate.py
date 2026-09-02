"""Offline harness for the question gate and the native-tool guards.

Stubs Telegram and state I/O; never touches the network, the live
state.json, or a real aside session. Run it:

    python3 tests/test_question_gate.py

What it pins is a production failure: a session started by texting the bot
had no instruction against the native ask_user_question tool, so the agent
called it, the daemon suspended the session waiting for an answer only the
Aside desktop sidepanel can give, and the thread was dead for good.
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "bridgemod", os.path.join(HERE, "bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# ---- stub out all side effects -------------------------------------
SENT = []           # tg() calls
BUBBLES = []        # send_bubbles()
TEXTS = []          # send_text()


def fake_tg(method, params=None, timeout=65):
    SENT.append((method, params or {}))
    return {"ok": True, "result": {"message_id": 4242}}


b.tg = fake_tg
b.save_json = lambda *a, **k: None
b.send_bubbles = lambda t: BUBBLES.append(t)
b.send_text = lambda t: TEXTS.append(t)
b.tg_send_status = lambda t: None
b.tg_edit = lambda *a, **k: True
b.tg_delete = lambda *a, **k: None
b.state["session_id"] = "TESTSESS"
b.state["approval"] = None
b.state["question"] = None

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


def drain_tasks():
    out = []
    while not b.TASKS.empty():
        out.append(b.TASKS.get_nowait())
    return out


BLOCK = (
    '[[QUESTION]]\n'
    '{"questions":[{"header":"Pick a branch",'
    '"question":"Which branch should I cut from?",'
    '"options":[{"label":"main","description":"the default"},'
    '{"label":"develop","description":"the integration branch"}]}]}\n'
    '[[/QUESTION]]'
)

# ---- 1. both presets carry the protocol ----------------------------
print("style presets")
for style in ("casual", "formal"):
    preset = b.STYLE_PRESETS[style]
    persona = preset["persona"].format(owner="Sam")
    check("%s: persona forbids ask_user_question" % style,
          "ask_user_question" in persona)
    check("%s: persona forbids request_action_confirmation" % style,
          "request_action_confirmation" in persona)
    check("%s: persona defines the [[QUESTION]] block" % style,
          b.QUESTION_FORMAT in persona)
    # The historical case-sensitivity bug: the two presets must agree on
    # the marker phrases even when their prose differs in tone.
    check("%s: persona keeps the [[APPROVAL]] protocol" % style,
          "[[APPROVAL]]" in persona and "[[/APPROVAL]]" in persona)
    check("%s: compact tag keeps only presentation style" % style,
          "Style reminder:" in preset["tag"]
          and "ask_user_question" not in preset["tag"]
          and "[[APPROVAL]]" not in preset["tag"])
    # The example JSON has to survive the persona's own .format pass.
    check("%s: the example block is parsable JSON" % style,
          json.loads(persona.split("[[QUESTION]]")[1]
                     .split("[[/QUESTION]]")[0].strip()) is not None)

# ---- 2. the per-message reminder -----------------------------------
print("\nfollow-up reminder")
check("policy names both native tools",
      b.NATIVE_QUESTION_TOOLS == (
          "ask_user_question", "request_action_confirmation"))
check("reminder is loaded from the shared policy",
      b.QUESTION_REMINDER.strip() == b.MOBILE_POLICY["followUpReminder"])
check("reminder points at the [[QUESTION]] block",
      "[[QUESTION]]" in b.QUESTION_REMINDER)
check("question example is loaded from the shared policy",
      json.loads(b.QUESTION_FORMAT.split(b.QUESTION_OPEN)[1]
                 .split(b.QUESTION_CLOSE)[0].strip())
      == b.MOBILE_POLICY["questionExample"])
check("reminder is one line of prompt, not a second preamble",
      len(b.QUESTION_REMINDER) < 220)

# ---- 3. parse_question ---------------------------------------------
print("\nparse_question")
q = b.parse_question("on it.\n\n" + BLOCK + "\n\ntell me which.")
check("parse: found", q is not None)
check("parse: header", q["header"] == "Pick a branch")
check("parse: question", q["question"] == "Which branch should I cut from?")
check("parse: options", [o["label"] for o in q["options"]] == ["main",
                                                              "develop"])
check("parse: descriptions kept",
      q["options"][0]["description"] == "the default")
check("parse: prose around the block survives",
      "on it." in q["rest"] and "tell me which." in q["rest"])
check("parse: markers stripped from the prose",
      "[[QUESTION]]" not in q["rest"])
check("parse: none when absent", b.parse_question("just a reply") is None)
check("parse: none on malformed json",
      b.parse_question("[[QUESTION]]\nnot json\n[[/QUESTION]]") is None)
check("parse: case-insensitive markers",
      b.parse_question(BLOCK.lower().replace("question", "QUESTION")
                       .replace("Pick", "Pick")) is not None
      or b.parse_question(BLOCK.replace("[[QUESTION]]", "[[question]]")
                          .replace("[[/QUESTION]]", "[[/question]]"))
      is not None)
bare = b.parse_question(
    '[[QUESTION]]{"header":"H","question":"Q?"}[[/QUESTION]]')
check("parse: a bare question with no options is still a question",
      bare is not None and bare["options"] == [])
many = b.parse_question(
    '[[QUESTION]]{"question":"Q?","options":[%s]}[[/QUESTION]]'
    % ",".join('{"label":"o%d"}' % i for i in range(20)))
check("parse: option list is capped",
      len(many["options"]) == b.MAX_QUESTION_OPTIONS)

# ---- 4. present_question -------------------------------------------
print("\npresent_question")
SENT.clear()
TEXTS.clear()
b.present_question(q)
method, params = SENT[-1]
check("present: sent a message", method == "sendMessage")
kb = json.loads(params["reply_markup"])["inline_keyboard"]
check("present: one button per option", len(kb) == 2)
check("present: button labels are the options",
      [row[0]["text"] for row in kb] == ["main", "develop"])
check("present: callback_data carries the index, not the label",
      kb[0][0]["callback_data"].endswith(":0")
      and kb[1][0]["callback_data"].endswith(":1"))
check("present: callback_data is within telegram's 64-byte cap",
      all(len(row[0]["callback_data"]) <= 64 for row in kb))
check("present: question text is in the message",
      "Which branch should I cut from?" in params["text"])
check("present: state records the pending question",
      b.state["question"] and b.state["question"]["options"] == ["main",
                                                                "develop"])
token = b.state["question"]["token"]

# ---- 5. tapping an option ------------------------------------------
print("\nquestion tap")
drain_tasks()
b._handle_question_tap("qst:%s:1" % token, 99)
tasks = drain_tasks()
check("tap: one task queued", len(tasks) == 1)
check("tap: answer carries header and label",
      tasks and tasks[0] == ("msg", "Pick a branch: develop"))
check("tap: the answer never starts with a dash",
      tasks and not tasks[0][1].startswith("-"))
check("tap: state cleared", b.state["question"] is None)

# a stale tap must not resolve anything
TEXTS.clear()
b.state["question"] = {"token": "LIVE", "header": "H", "question": "Q",
                       "options": ["a"], "session_id": "s",
                       "message_id": 1, "ts": 0}
b._handle_question_tap("qst:STALE:0", 1)
check("stale: not consumed", b.state["question"] is not None)
check("stale: user told", any("isn't open anymore" in t for t in TEXTS))

# an out-of-range index must not crash
TEXTS.clear()
b._handle_question_tap("qst:LIVE:99", 1)
check("bad index: told to reply instead",
      any("couldn't tell which option" in t for t in TEXTS))
b.state["question"] = None

# ---- 5b. the raw block never reaches the chat ----------------------
print("\nmarker blocks stay out of the chat")
BUBBLES.clear()
turn_q = b.TurnStream()
# The question text has a "?" in it, which is what used to trip the
# urgent path and send the raw JSON as a bubble.
turn_q.on_block("here you go\n\n" + BLOCK)
check("on_block: markers stripped from what is shown",
      all("[[QUESTION]]" not in x for x in BUBBLES))
check("on_block: the prose around it survives",
      turn_q.last_block == "here you go")

BUBBLES.clear()
turn_only = b.TurnStream()
turn_only.on_block(BLOCK)
turn_only.finish()
check("on_block: a block-only message sends no bubble at all",
      BUBBLES == [])

BUBBLES.clear()
turn_ap = b.TurnStream()
turn_ap.on_block("[[APPROVAL]]\nAction: Send it?\nDetails: to sam\n"
                 "[[/APPROVAL]]")
turn_ap.finish()
check("on_block: an approval block is still kept out too", BUBBLES == [])

# The prose around a question DOES land, as an ordinary reply, before
# the buttons -- the question gate no longer suppresses the final block.
BUBBLES.clear()
turn_prose = b.TurnStream()
turn_prose.on_block("here you go\n\n" + BLOCK)
turn_prose.finish()
check("on_block: prose around a question is still sent",
      BUBBLES == ["here you go"])

BUBBLES.clear()
turn_plain = b.TurnStream()
turn_plain.on_block("just a normal reply")
turn_plain.finish()
check("on_block: an ordinary reply is untouched",
      BUBBLES == ["just a normal reply"])


# ---- 6. the approval protocol is untouched -------------------------
print("\napproval still works")
ap = b.parse_approval(
    "[[APPROVAL]]\nAction: Send an email\nDetails: to sam\n[[/APPROVAL]]")
check("approval: still parsed", ap and ap["action"] == "Send an email")
check("approval: a turn with both is an approval, not a question",
      b.parse_approval("[[APPROVAL]]\nAction: X\n[[/APPROVAL]]\n" + BLOCK)
      is not None)

# ---- 7. the native tools are still reported ------------------------
print("\nnative tool guards")
TEXTS.clear()
tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
tf.write(json.dumps({
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "tc1",
                 "name": "ask_user_question",
                 "arguments": {"questions": [
                     {"header": "Pick", "question": "Which one?"}]}}],
}) + "\n")
tf.close()
turn = b.TurnStream()
b.stream_new(tf.name, 0, turn)
os.unlink(tf.name)
check("native ask: notified once", turn.native_confirm_notified)
check("native ask: says only the desktop can answer",
      any("only aside on your computer can answer" in t for t in TEXTS))
check("native ask: offers /new as the way forward",
      any("/new" in t for t in TEXTS))

TEXTS.clear()
tf = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
tf.write(json.dumps({
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "tc2",
                 "name": "request_action_confirmation",
                 "arguments": {"title": "Send email", "message": "ok?"}}],
}) + "\n")
tf.close()
turn2 = b.TurnStream()
b.stream_new(tf.name, 0, turn2)
os.unlink(tf.name)
check("native confirm: still notified",
      turn2.native_confirm_notified
      and any("browser-level confirmation" in t for t in TEXTS))

# ---- 8. a fresh session is created with the native flag off --------
print("\nnew-session settings")
expr = b.new_session_settings_expression("SESS-1")
check("new session: keeps full-access", "permissionMode: 'full-access'" in expr)
check("new session: forces finalConfirm off", "finalConfirm: false" in expr)
check("new session: never turns it on", "finalConfirm: true" not in expr)
check("new session: id is a JSON literal, not interpolated quotes",
      '"SESS-1"' in expr)
# The id comes from a directory name, but it is JSON-encoded rather than
# wrapped in quotes-and-concat, so it cannot terminate the literal and
# become code the daemon evaluates.
check("new session: a quote in the id cannot break out of the literal",
      json.dumps('a"b') in b.new_session_settings_expression('a"b'))


# ---- 9. display stripping ------------------------------------------
print("\ndisplay stripping")
MINIAPP_PREAMBLE = (
    "[Aside Mini App session. You are running for a user on their phone.\n"
    "They cannot answer interactive tool prompts here.\n"
    "do not keep working while you wait.]"
)
check("strip: the Mini App preamble comes off the front",
      b.strip_agent_directives(
          MINIAPP_PREAMBLE + "\n\nplan the offsite")
      == "plan the offsite")
check("strip: the reminder comes off the back",
      b.strip_agent_directives("check the deploy" + b.QUESTION_REMINDER)
      == "check the deploy")
check("strip: the compact style reminder comes off",
      b.strip_agent_directives("hello" + b.STYLE_TAG + b.QUESTION_REMINDER)
      == "hello")
check("strip: ordinary text is untouched",
      b.strip_agent_directives("just a message") == "just a message")

print("\n%d failed" % len(fails))
sys.exit(1 if fails else 0)
