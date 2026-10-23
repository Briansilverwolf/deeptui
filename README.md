# deeptui

A full-screen terminal UI for Python **deepagents**, built with OpenTUI (Bun + React).
It launches your agent itself, never crashes on agent errors, remembers your conversation,
and lets you turn tools on and off for the main agent and every subagent.

## Install (Windows, macOS, Linux)

1. Install Bun: https://bun.sh  (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`)
2. In this folder, in the Python environment your agent already uses:

   ```
   pip install -e .
   ```
   (installs the `deeptui` helper package; it brings `langgraph-checkpoint-sqlite`)
3. ```
   cd tui
   bun install
   ```

## Wire up your agent (3 lines)

See `examples/my_agent.py`. In your factory:

```python
create_deep_agent(
    ...,
    checkpointer=ctx.checkpointer,                # saves the conversation
    middleware=[ctx.toggles.middleware("main")],  # main-agent tool toggles
    subagents=ctx.toggles.attach(my_subagents),   # subagent tool toggles
    interrupt_on={...},                           # approvals (optional)
)
```
Keep your own `middleware=[...]` entries; just add the toggle one to the list.
If you pass a ready-made compiled agent instead of a factory, it still works; you just
won't get tool toggles (and it must already have a checkpointer).

## Run

```
cd tui
bun run src/index.tsx path\to\my_agent.py:build_agent
bun run demo                       # keyless demo agent to try the UI
```
Options: `--python <path>` (default: `.venv` in the folder you run from, then `python`/`py`),
`--new` (fresh conversation), `--thread <id>`, `--state-dir <dir>`.
API keys: put them in a `.env` in the folder you run from (loaded if `python-dotenv` is installed)
or set them in the environment.

## Keys

| Key | Does |
|---|---|
| Enter / Shift+Enter | send / new line |
| Esc or Ctrl+C | **stop** the running turn |
| Ctrl+R | **continue** an unfinished or failed turn; if nothing to continue, **resend** your last message |
| Ctrl+T | tools on/off per agent (Space toggles, a/n all on/off) |
| Ctrl+G | the exact system prompt each agent received |
| Ctrl+O | todos (always shown in a sidebar on wide terminals) |
| Ctrl+E | expand tool output |
| Ctrl+L | logs (everything your agent prints to stderr) |
| Ctrl+K | restart the agent process (reload your code after editing) |
| Ctrl+N twice | new conversation |
| y / n / e | approve / reject (with reason) / edit args as JSON |
| Ctrl+Q | quit |

Slash commands: `/help /tools /prompt /todos /logs /retry /stop /new /reload /history N /quit`.

## What happens on errors

* Agent raises (bad key, rate limit, tool bug): shown in the transcript, UI keeps running,
  Ctrl+R retries from the checkpoint, or just type a new message.
* Python process dies: the UI says so and restarts it (up to 5 times, with backoff);
  the conversation is reloaded from disk.
* Your agent file has an error at load time: a panel shows the real message; fix, Ctrl+K.
* On reopen you see the last 5 messages (and how many older ones are hidden), the todos,
  and any approval that was still waiting.

## Where things are stored

`%USERPROFILE%\.deeptui\<agent>\` (override with `DEEPTUI_HOME` or `--state-dir`):
`checkpoints.sqlite` (conversation), `toggles.json`, `session.json`, `prompts.json`,
`bridge.log`, `tui.log`.

## Notes / limits

* Disabled tools are hidden from the model and any call to them is refused. Takes effect
  on the agent's next step. deepagents' built-in `general-purpose` subagent doesn't inherit
  your middleware, so `attach()` adds an explicit one (same prompt/tools) so it can be toggled.
* The system prompt is captured the first time each agent calls the model.
* Subagent text is shown after it finishes a step (indented, tagged with its name).
* Tested on Linux with a scripted model. Windows was not available to me; the code uses
  cross-platform process handling (`python`, `py -3`, `.venv\Scripts\python.exe`). If the
  agent won't start, Ctrl+L shows why.

## Tests

```
cd tui && bun run typecheck && bun run test && bun run test/edge.test.tsx
```
