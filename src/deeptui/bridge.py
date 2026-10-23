"""NDJSON stdio bridge between the OpenTUI front end and a deepagents agent.

stdin  <- one JSON command per line   {"cmd": "send", "text": "..."}
stdout -> one JSON event per line     {"type": "delta", "text": "..."}
stderr -> free-form logs (anything your agent prints ends up here, never in the protocol)

The bridge never exits because of an agent error: errors become ``error`` events and
the conversation can be retried or continued.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import threading
import traceback
import uuid
from pathlib import Path
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from . import loader
from .context import AgentContext
from .toggles import ToolToggles

MAX_TOOL_OUTPUT = 6000
HISTORY_DEFAULT = 5


# --------------------------------------------------------------------------- helpers
def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict) and b.get("type") in ("text", "output_text"):
                parts.append(str(b.get("text", "")))
        return "".join(parts)
    return "" if content is None else str(content)


def clip(s: str, n: int = MAX_TOOL_OUTPUT) -> str:
    return s if len(s) <= n else s[:n] + f"\n… ({len(s) - n} more characters)"


def unwrap(value: Any) -> Any:
    """LangGraph may wrap reducer values (Overwrite). Return the plain value."""
    inner = getattr(value, "value", None)
    return inner if inner is not None and not isinstance(value, (list, dict, str)) else value


def default_state_dir(target: str) -> Path:
    key = re.sub(r"[^A-Za-z0-9._-]+", "_", target).strip("_")[-60:] or "agent"
    base = os.environ.get("DEEPTUI_HOME") or str(Path.home() / ".deeptui")
    return Path(base) / key


class Protocol:
    """Thread-safe NDJSON writer bound to the *original* stdout."""

    def __init__(self, stream: Any) -> None:
        self._s = stream
        self._lock = threading.Lock()

    def send(self, type_: str, **data: Any) -> None:
        line = json.dumps({"type": type_, **data}, ensure_ascii=False, default=str)
        with self._lock:
            try:
                self._s.write(line + "\n")
                self._s.flush()
            except Exception:
                pass  # the TUI went away; the reader thread will notice and quit


class PromptCapture(BaseCallbackHandler):
    """Records the real system prompt each agent sends to its model."""

    raise_error = False

    def __init__(self, bridge: "Bridge") -> None:
        self.bridge = bridge

    def on_chat_model_start(self, serialized: Any, messages: list[list[BaseMessage]], **kwargs: Any) -> None:
        try:
            meta = kwargs.get("metadata") or {}
            if meta.get("lc_source") == "summarization":
                return
            ns = str(meta.get("langgraph_checkpoint_ns", ""))
            scope = meta.get("lc_agent_name") or ("main" if "tools:" not in ns else "subagent")
            for m in messages[0] if messages else []:
                if getattr(m, "type", "") == "system":
                    self.bridge.record_prompt(scope, text_of(m.content))
                    break
        except Exception:
            pass


# --------------------------------------------------------------------------- bridge
class Bridge:
    def __init__(self, target: str, state_dir: Path, out: Protocol, thread_id: str | None) -> None:
        self.target = target
        self.dir = state_dir
        self.out = out
        self.toggles = ToolToggles(state_dir / "toggles.json")
        self.toggles.on_change(self._tools_changed)
        self.agent: Any = None
        self.agent_name = target
        self.thread_id = thread_id or str(uuid.uuid4())
        self.busy = False
        self.task: asyncio.Task[None] | None = None
        self.pending: list[dict[str, Any]] = []  # interrupts awaiting a decision
        self.prompts: dict[str, str] = {}
        self.session: dict[str, Any] = {}
        self.seen_tool_starts: set[str] = set()
        self.tool_agent: dict[str, tuple[str, int]] = {}
        self.capture = PromptCapture(self)
        self.loop: asyncio.AbstractEventLoop | None = None
        self._load_files()

    # ---- persistence -------------------------------------------------------------
    def _load_files(self) -> None:
        for name, attr in (("session.json", "session"), ("prompts.json", "prompts")):
            try:
                setattr(self, attr, json.loads((self.dir / name).read_text(encoding="utf-8")))
            except Exception:
                pass
        if not isinstance(self.session, dict):
            self.session = {}
        if not isinstance(self.prompts, dict):
            self.prompts = {}

    def _write(self, name: str, data: Any) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = self.dir / (name + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.dir / name)
        except Exception:
            pass

    def save_session(self, **updates: Any) -> None:
        self.session.update(updates)
        self.session["thread_id"] = self.thread_id
        self._write("session.json", self.session)

    def record_prompt(self, scope: str, text: str) -> None:
        if not text or self.prompts.get(scope) == text:
            return
        self.prompts[scope] = text
        self._write("prompts.json", self.prompts)
        self._emit_from_thread("system_prompts", prompts=self.prompts)

    def _emit_from_thread(self, type_: str, **data: Any) -> None:
        self.out.send(type_, **data)

    def _tools_changed(self) -> None:
        self.out.send("tools", scopes=self.toggles.snapshot())

    def config(self) -> dict[str, Any]:
        return {"configurable": {"thread_id": self.thread_id}, "callbacks": [self.capture]}

    # ---- startup -----------------------------------------------------------------
    async def start(self, saver: Any) -> None:
        self.loop = asyncio.get_running_loop()
        ctx = AgentContext(checkpointer=saver, toggles=self.toggles, state_dir=self.dir)
        self.agent, self.agent_name = await loader.build(self.target, ctx)
        self._prime_main_tools()
        await self.announce()

    def _prime_main_tools(self) -> None:
        """Best effort: list the main agent's tools before the first model call."""
        try:
            node = self.agent.nodes["tools"].bound
            names = list(getattr(node, "tools_by_name", {}).keys())
            if names and "main" in self.toggles.scopes:
                self.toggles.note_tools("main", names)
        except Exception:
            pass

    async def announce(self) -> None:
        self.out.send(
            "ready",
            thread_id=self.thread_id,
            agent=self.agent_name,
            toggles_supported=bool(self.toggles.scopes),
            state_dir=str(self.dir),
        )
        await self.send_history()
        self.out.send("tools", scopes=self.toggles.snapshot())
        self.out.send("system_prompts", prompts=self.prompts)
        await self.refresh_state(announce_pending=True)

    # ---- state inspection --------------------------------------------------------
    async def snapshot_state(self) -> tuple[Any, list[Any]]:
        state = await self.agent.aget_state(self.config())
        interrupts = list(getattr(state, "interrupts", ()) or [])
        if not interrupts:
            for t in getattr(state, "tasks", ()) or ():
                interrupts.extend(getattr(t, "interrupts", ()) or ())
        seen: set[str] = set()
        unique = []
        for it in interrupts:
            iid = str(getattr(it, "id", id(it)))
            if iid not in seen:
                seen.add(iid)
                unique.append(it)
        return state, unique

    def _normalize_interrupt(self, it: Any) -> dict[str, Any]:
        value = getattr(it, "value", it)
        iid = str(getattr(it, "id", uuid.uuid4()))
        if isinstance(value, dict) and "action_requests" in value:
            cfgs = {c.get("action_name"): c for c in value.get("review_configs", []) if isinstance(c, dict)}
            actions = []
            for a in value["action_requests"]:
                cfg = cfgs.get(a.get("name"), {})
                actions.append(
                    {
                        "name": a.get("name"),
                        "args": a.get("args", {}),
                        "description": a.get("description", ""),
                        "allowed": cfg.get("allowed_decisions", ["approve", "edit", "reject"]),
                    }
                )
            return {"id": iid, "kind": "hitl", "actions": actions}
        return {"id": iid, "kind": "value", "actions": [], "value": value}

    async def refresh_state(self, announce_pending: bool = False) -> None:
        try:
            state, interrupts = await self.snapshot_state()
        except Exception as e:
            self.out.send("warning", message=f"could not read state: {e}")
            return
        values = getattr(state, "values", None) or {}
        todos = values.get("todos") if isinstance(values, dict) else None
        self.out.send("todos", todos=todos or [])
        self.pending = [self._normalize_interrupt(i) for i in interrupts]
        if self.pending and announce_pending:
            self.out.send("interrupt", items=self.pending)
        elif announce_pending and getattr(state, "next", None):
            self.out.send(
                "unfinished",
                next=list(state.next),
                last_error=self.session.get("last_error"),
            )

    async def send_history(self, n: int = HISTORY_DEFAULT) -> None:
        msgs: list[dict[str, Any]] = []
        try:
            state = await self.agent.aget_state(self.config())
            values = getattr(state, "values", None) or {}
            for m in values.get("messages", []) if isinstance(values, dict) else []:
                if isinstance(m, HumanMessage):
                    t = text_of(m.content).strip()
                    if t:
                        msgs.append({"id": m.id, "role": "user", "text": t})
                elif isinstance(m, AIMessage):
                    t = text_of(m.content).strip()
                    if t:
                        msgs.append({"id": m.id, "role": "assistant", "text": t})
        except Exception as e:
            self.out.send("warning", message=f"could not load history: {e}")
        self.out.send("history", messages=msgs[-n:], thread_id=self.thread_id, total=len(msgs))

    # ---- commands ----------------------------------------------------------------
    async def handle(self, cmd: dict[str, Any]) -> bool:
        """Handle one command. Returns False when the bridge should exit."""
        name = cmd.get("cmd")
        try:
            if name == "send":
                await self.cmd_send(str(cmd.get("text", "")))
            elif name == "retry":
                await self.cmd_retry()
            elif name == "cancel":
                await self.cmd_cancel()
            elif name == "resume":
                await self.cmd_resume(cmd.get("decisions") or [])
            elif name == "history":
                await self.send_history(int(cmd.get("n", HISTORY_DEFAULT)))
            elif name == "new_thread":
                await self.cmd_new_thread()
            elif name == "set_tool":
                self.toggles.set_enabled(str(cmd["scope"]), str(cmd["tool"]), bool(cmd["enabled"]))
            elif name == "get_tools":
                self.out.send("tools", scopes=self.toggles.snapshot())
            elif name == "get_prompts":
                self.out.send("system_prompts", prompts=self.prompts)
            elif name == "get_todos":
                await self.refresh_state()
            elif name == "ping":
                self.out.send("pong")
            elif name == "quit":
                return False
            else:
                self.out.send("warning", message=f"unknown command: {name!r}")
        except Exception as e:  # a bad command must never kill the bridge
            self.report_error(e)
        return True

    def _reject(self, reason: str) -> None:
        self.out.send("rejected", reason=reason)

    async def cmd_send(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if self.busy:
            return self._reject("The agent is still working. Stop it first (Esc).")
        if self.pending:
            return self._reject("Approve or reject the pending tool call first.")
        self.save_session(last_user_text=text, last_error=None)
        self.out.send("user_message", text=text)
        self.start_run({"messages": [{"role": "user", "content": text}]})

    async def cmd_retry(self) -> None:
        """Continue an unfinished/failed turn; if there is nothing to continue, resend the last message."""
        if self.busy:
            return self._reject("The agent is still working.")
        if self.pending:
            return self._reject("Approve or reject the pending tool call first.")
        state, _ = await self.snapshot_state()
        if getattr(state, "next", None):
            self.save_session(last_error=None)
            self.out.send("info", message="Continuing the unfinished turn…")
            self.start_run(None)
            return
        last = self.session.get("last_user_text")
        if not last:
            return self._reject("Nothing to resend yet.")
        self.save_session(last_error=None)
        self.out.send("user_message", text=last, resend=True)
        self.start_run({"messages": [{"role": "user", "content": last}]})

    async def cmd_cancel(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
        else:
            self.out.send("info", message="Nothing is running.")

    async def cmd_new_thread(self) -> None:
        if self.busy:
            return self._reject("Stop the agent before starting a new conversation.")
        self.thread_id = str(uuid.uuid4())
        self.pending = []
        self.save_session(last_error=None, last_user_text=None)
        await self.announce()

    async def cmd_resume(self, decisions: list[dict[str, Any]]) -> None:
        if self.busy:
            return self._reject("The agent is still working.")
        if not self.pending:
            return self._reject("There is nothing waiting for approval.")
        from langgraph.types import Command

        needed = sum(max(len(p["actions"]), 1) for p in self.pending)
        if len(decisions) != needed:
            return self._reject(f"Expected {needed} decision(s), got {len(decisions)}.")

        per_interrupt: dict[str, Any] = {}
        i = 0
        for p in self.pending:
            if p["kind"] == "hitl":
                k = len(p["actions"])
                per_interrupt[p["id"]] = {"decisions": [self._decision(d) for d in decisions[i : i + k]]}
                i += k
            else:
                d = decisions[i]
                per_interrupt[p["id"]] = d.get("value", d.get("message", ""))
                i += 1
        resume: Any = next(iter(per_interrupt.values())) if len(per_interrupt) == 1 else per_interrupt
        self.pending = []
        self.out.send("interrupt_resolved")
        self.start_run(Command(resume=resume))

    @staticmethod
    def _decision(d: dict[str, Any]) -> dict[str, Any]:
        t = d.get("type")
        if t == "edit":
            return {"type": "edit", "edited_action": d["edited_action"]}
        if t == "reject":
            out: dict[str, Any] = {"type": "reject"}
            if d.get("message"):
                out["message"] = d["message"]
            return out
        if t == "respond":
            return {"type": "respond", "message": d.get("message", "")}
        return {"type": "approve"}

    # ---- running a turn ----------------------------------------------------------
    def start_run(self, payload: Any) -> None:
        self.busy = True
        self.out.send("state", busy=True)
        self.task = asyncio.create_task(self._run(payload))

    async def _run(self, payload: Any) -> None:
        try:
            stream = self.agent.astream(
                payload,
                self.config(),
                stream_mode=["messages", "updates"],
                subgraphs=True,
            )
            async for item in stream:
                try:
                    self.on_chunk(item)
                except Exception as e:  # a rendering problem must not abort the run
                    self.out.send("warning", message=f"stream chunk skipped: {type(e).__name__}: {e}")
            self.out.send("run_end", status="ok")
        except asyncio.CancelledError:
            self.out.send("run_end", status="cancelled")
            self.save_session(last_error=None)
        except Exception as e:
            self.report_error(e)
            self.out.send("run_end", status="error")
        finally:
            self.busy = False
            await self._shielded_refresh()
            self.out.send("state", busy=False)

    async def _shielded_refresh(self) -> None:
        try:
            await asyncio.shield(self.refresh_state(announce_pending=True))
        except BaseException:
            pass

    def report_error(self, e: BaseException) -> None:
        msg = f"{type(e).__name__}: {e}"
        trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-3500:]
        print(trace, file=sys.stderr, flush=True)
        self.save_session(last_error=msg)
        self.out.send("error", message=msg, trace=trace)

    # ---- stream decoding ---------------------------------------------------------
    @staticmethod
    def scope_of(ns: tuple[str, ...], meta: dict[str, Any] | None, msg: Any = None) -> str:
        name = (meta or {}).get("lc_agent_name") or getattr(msg, "name", None)
        if not ns:
            return "main"
        return str(name) if name else "subagent"

    def on_chunk(self, item: Any) -> None:
        ns, mode, data = item
        ns = tuple(ns) if isinstance(ns, (tuple, list)) else ()
        if mode == "messages":
            msg, meta = data
            if (meta or {}).get("lc_source") == "summarization":
                return
            if isinstance(msg, ToolMessage):
                return
            text = text_of(getattr(msg, "content", ""))
            if text:
                self.out.send(
                    "delta",
                    text=text,
                    id=getattr(msg, "id", None),
                    agent=self.scope_of(ns, meta, msg),
                    depth=len(ns),
                )
        elif mode == "updates" and isinstance(data, dict):
            for node, update in data.items():
                if node == "__interrupt__" or not isinstance(update, dict):
                    continue
                if "todos" in update:
                    todos = unwrap(update["todos"])
                    if isinstance(todos, list):
                        self.out.send("todos", todos=todos)
                raw = unwrap(update.get("messages")) if "messages" in update else None
                if isinstance(raw, BaseMessage):
                    raw = [raw]
                for m in raw or []:
                    self.on_message(m, ns)

    def on_message(self, m: Any, ns: tuple[str, ...]) -> None:
        agent = self.scope_of(ns, None, m)
        if isinstance(m, AIMessage):
            self.out.send("ai_done", id=m.id, agent=agent, depth=len(ns), text=text_of(m.content))
            for tc in m.tool_calls or []:
                tid = tc.get("id") or str(uuid.uuid4())
                key = f"{tid}"
                if key in self.seen_tool_starts:
                    continue
                self.seen_tool_starts.add(key)
                self.tool_agent[key] = (agent, len(ns))
                self.out.send(
                    "tool_start",
                    id=tid,
                    name=tc.get("name"),
                    args=tc.get("args", {}),
                    agent=agent,
                    depth=len(ns),
                )
        elif isinstance(m, ToolMessage):
            agent, depth = self.tool_agent.get(m.tool_call_id, (agent, len(ns)))
            self.out.send(
                "tool_end",
                id=m.tool_call_id,
                name=m.name,
                ok=m.status != "error",
                output=clip(text_of(m.content)),
                agent=agent,
                depth=depth,
            )


# --------------------------------------------------------------------------- main loop
def start_reader(loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[dict[str, Any] | None]") -> None:
    def run() -> None:
        stream = sys.stdin.buffer
        while True:
            try:
                line = stream.readline()
            except Exception:
                break
            if not line:
                break
            try:
                obj = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            if isinstance(obj, dict):
                loop.call_soon_threadsafe(queue.put_nowait, obj)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=run, name="stdin-reader", daemon=True).start()


async def amain(args: argparse.Namespace, out: Protocol) -> int:
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    state_dir = Path(args.state_dir) if args.state_dir else default_state_dir(args.target)
    state_dir.mkdir(parents=True, exist_ok=True)

    session: dict[str, Any] = {}
    try:
        session = json.loads((state_dir / "session.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    thread_id = args.thread or session.get("thread_id")

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    start_reader(loop, queue)

    async with AsyncSqliteSaver.from_conn_string(str(state_dir / "checkpoints.sqlite")) as saver:
        bridge = Bridge(args.target, state_dir, out, thread_id)
        try:
            await bridge.start(saver)
        except Exception as e:
            # The agent failed to load. Stay alive so the TUI can show why and offer a reload.
            trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-3500:]
            print(trace, file=sys.stderr, flush=True)
            out.send("fatal", message=f"{type(e).__name__}: {e}", trace=trace)
            while True:
                cmd = await queue.get()
                if cmd is None or cmd.get("cmd") == "quit":
                    return 1
                if cmd.get("cmd") == "ping":
                    out.send("pong")

        while True:
            cmd = await queue.get()
            if cmd is None:
                break
            if not await bridge.handle(cmd):
                break
        if bridge.task and not bridge.task.done():
            bridge.task.cancel()
            try:
                await bridge.task
            except BaseException:
                pass
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="deeptui-bridge", description=__doc__)
    ap.add_argument("target", help="module:attr or path/to/agent.py:attr (factory taking ctx, zero-arg factory, or compiled agent)")
    ap.add_argument("--state-dir", help="where checkpoints and TUI state live (default ~/.deeptui/<target>)")
    ap.add_argument("--thread", help="conversation thread id (default: the last one used)")
    args = ap.parse_args(argv)

    # Keep fd 1 for the protocol only; anything the agent prints goes to stderr.
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    proto_stream = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    out = Protocol(proto_stream)
    try:
        return asyncio.run(amain(args, out))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
