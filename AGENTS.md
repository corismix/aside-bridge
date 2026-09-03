# Repository Guidelines

## Project Structure & Architecture

`bridge.py` is the macOS Telegram bridge: it long-polls Telegram, invokes the
local `aside` CLI, and reads session transcripts. Supporting installer and
service code lives in `setup.py`, `bridgemon.py`, `monitor.py`, and
`com.aside.bridge.plist`; Python regression tests are in `tests/`.

`miniapp/` is an npm workspace. Its Fastify/WebSocket server is in
`miniapp/server/src/`, its React/Vite client is in `miniapp/web/src/`, and
their Vitest suites live beside them in `server/test/` and `web/test/`.
Read `docs/MINIAPP.md` before changing the mobile path and `docs/AUDIT.md`
before touching authentication, tunnels, tokens, files, or permissions.

## Build, Test, and Development Commands

Run Python tests from the repository root. The files in `tests/` are
standalone scripts, not unittest modules, so `python3 -m unittest discover`
errors on them - run each script directly (CI does the same). `bridge.py`
exits at import without a `config.json`, so seed the example config first:

```bash
cp config.example.json config.json
python3 tests/test_approval_gate.py   # repeat for each tests/test_*.py
```

`tests/test_approval_e2e.py` drives a live Aside CLI session and only works
on a macOS Aside install; anywhere else it prints a skip note and exits
cleanly. `.github/workflows/ci.yml` runs the offline harnesses the same way.

Set up or reconfigure the local bridge with `python3 setup.py`. For Mini App
development, install dependencies once, then use its workspace scripts:

```bash
cd miniapp && npm install
cd miniapp && npm run dev
cd miniapp && npm run typecheck && npm test
cd miniapp && npm run build
```

`npm run dev` starts the server and Vite client; `typecheck`, `test`, and
`build` cover both workspaces. The real Mini App needs Node 20+ and an Aside
installation. Do not treat a local build as proof of Telegram, launchd, or
tunnel behaviour.

## Coding Style & Naming Conventions

Follow nearby code. Python uses four-space indentation, `snake_case` names,
and standard-library modules where practical. TypeScript uses two spaces,
semicolons, `camelCase` values/functions, and `PascalCase` React components
such as `SessionPanel.tsx`. Keep server behavior in `miniapp/server/src/` and
presentation logic in `miniapp/web/src/`; avoid cross-layer shortcuts.

## Testing and Safety Boundaries

Add focused `test_*.py` or `*.test.ts(x)` coverage for observable regressions.
Run the closest affected suite first, then the workspace checks above for
shared Mini App changes. Never write Aside's `state.db`; use the sanctioned
Aside CLI/facade paths. Keep `config.json`, tokens, JWT secrets, logs, uploads,
and generated `dist/` output out of commits.

## Commits and Pull Requests

Use Conventional Commit subjects: `fix: recover expired sessions` or
`feat: add project picker`. Keep commits focused. PRs should explain user
impact, describe validation run, link relevant issues, and include screenshots
or a short recording for visible Mini App changes. Call out any manual
Telegram, launchd, tunnel, or authentication checks that remain unverified.
