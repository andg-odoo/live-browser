# live-browser

A Claude Code mod that opens a live, logged-in Odoo browser in a pane next to the chat. One headless Chrome per
session, streamed into the terminal at about 20 fps while the page changes.

## Use

- `/live-browser [env] [steps; ...]` opens the pane on that env's running Odoo (bare: the default env, Odoo home) and
  runs the steps once. `/live-browser list` shows the running servers and which one this session uses.
- The pane shows `env · db · :port · path`, a status line, an error line and a step field. Typing filters the step
  verbs (`goto`, `open`, `click`, `fill`, `select`, `check`, `uncheck`, `expect`, `wait`, `shot`), then the live
  page's targets: `click` rows carry their kind (action, smart button, tab, option, status, link, chatter, menu),
  `fill` lists typed fields, `select` lists dropdowns and `select LABEL=` lists that dropdown's options. Tab/Enter
  complete, Enter on a full step runs it, ↑ on an empty field recalls history.
- The mod sets `$ODOO_LIVE_SOCKET` for the session's Bash commands, so scripts the agent runs drive the same browser.
- Closing the pane ends the browser.

Limits: the picture itself is not clickable, dropdown options are the first ~8 the field offers, and inside tmux each
frame is capped at 2 MiB.

## Requirements

The browser itself is driven by `live.py` and `target.py` from odoo-shots, a separate set of Playwright scripts that
is not published yet. The mod looks for them in `$ODOO_SHOTS`, else `~/Dev/scratch/odoo-shots`, and needs `python3`
and [`uv`](https://docs.astral.sh/uv/) on `PATH` (Playwright is pulled in by `uv run --with playwright`).

## Install

Clone it anywhere and add the folder to `CLAUDE_CODE_PLUGIN_DIRS` (colon-separated) in the `env` block of
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/live-browser", "ODOO_SHOTS": "/path/to/odoo-shots" } }
```

## Develop

```sh
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc` needs the Claude Code SDK typings in `.claude-plugin/types/`, which Claude Code writes when it scaffolds a mod
and which are not committed. The tests run without them. A running browser belongs to the copy of the mod that
started it, so rerun `/live-browser` after reloading the mod.
