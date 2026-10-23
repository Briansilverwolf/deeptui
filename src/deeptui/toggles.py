"""Runtime tool toggles for the main agent and each subagent.

A disabled tool is (1) removed from the tool list the model sees and (2) rejected
if the model still manages to call it. Toggles take effect on the next model call,
so you can flip them in the middle of a conversation.

Usage inside your agent factory::

    def build_agent(ctx):
        return create_deep_agent(
            ...,
            middleware=[ctx.toggles.middleware("main")],
            subagents=ctx.toggles.attach([my_subagent_spec]),
            checkpointer=ctx.checkpointer,
        )
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage


def _tool_name(tool: Any) -> str | None:
    if isinstance(tool, dict):
        name = tool.get("name")
        if not isinstance(name, str):
            fn = tool.get("function")
            name = fn.get("name") if isinstance(fn, dict) else None
        return name if isinstance(name, str) else None
    name = getattr(tool, "name", None)
    if isinstance(name, str):
        return name
    name = getattr(tool, "__name__", None)
    return name if isinstance(name, str) else None


class ToolToggles:
    """Shared registry of which tools are disabled in which scope.

    A *scope* is ``"main"`` or a subagent name (``"general-purpose"``, ``"researcher"``...).
    State is persisted to ``path`` so it survives restarts.
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path else None
        self._lock = threading.RLock()
        self._disabled: dict[str, set[str]] = {}
        self._seen: dict[str, list[str]] = {}
        self._scopes: list[str] = []
        self._listeners: list[Callable[[], None]] = []
        self._load()

    # ------------------------------------------------------------------ persistence
    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._disabled = {k: set(v) for k, v in data.get("disabled", {}).items()}
            self._seen = {k: list(v) for k, v in data.get("seen", {}).items()}
        except Exception:  # corrupt file must never stop the app
            self._disabled, self._seen = {}, {}

    def _save(self) -> None:
        if not self._path:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "disabled": {k: sorted(v) for k, v in self._disabled.items() if v},
                "seen": self._seen,
            }
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            pass

    # ------------------------------------------------------------------ public API
    def middleware(self, scope: str) -> "ToggleMiddleware":
        """Middleware that applies this registry to one agent. Call once per agent."""
        with self._lock:
            if scope not in self._scopes:
                self._scopes.append(scope)
        return ToggleMiddleware(self, scope)

    def attach(
        self,
        subagents: Sequence[dict[str, Any]] | None = None,
        *,
        inherited_tools: Sequence[Any] = (),
        include_general_purpose: bool = True,
    ) -> list[dict[str, Any]]:
        """Return copies of your subagent specs with the toggle middleware added.

        deepagents' built-in ``general-purpose`` subagent does not inherit custom
        middleware, so an explicit ``general-purpose`` spec is added (unless you
        already defined one or pass ``include_general_purpose=False``).

        ``inherited_tools`` are the tools your main agent passes via ``tools=``; they
        let the TUI list those names for subagents before the first run.
        """
        from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT

        specs = [dict(s) for s in (subagents or [])]
        if include_general_purpose and not any(s.get("name") == "general-purpose" for s in specs):
            specs.insert(0, dict(GENERAL_PURPOSE_SUBAGENT))
        inherited = [n for n in (_tool_name(t) for t in inherited_tools) if n]
        out: list[dict[str, Any]] = []
        for spec in specs:
            if "graph_id" in spec or "runnable" in spec:  # async / compiled subagents: cannot inject
                out.append(spec)
                continue
            name = spec["name"]
            own = [n for n in (_tool_name(t) for t in spec.get("tools", [])) if n]
            self.note_tools(name, own if "tools" in spec else inherited)
            spec["middleware"] = [*spec.get("middleware", []), self.middleware(name)]
            out.append(spec)
        return out

    def note_tools(self, scope: str, names: Sequence[str]) -> None:
        with self._lock:
            known = self._seen.setdefault(scope, [])
            changed = False
            for n in names:
                if n and n not in known:
                    known.append(n)
                    changed = True
            if scope not in self._scopes:
                self._scopes.append(scope)
            if changed:
                self._save()
        if changed:
            self._notify()

    def is_disabled(self, scope: str, tool: str) -> bool:
        with self._lock:
            return tool in self._disabled.get(scope, ())

    def set_enabled(self, scope: str, tool: str, enabled: bool) -> None:
        with self._lock:
            bucket = self._disabled.setdefault(scope, set())
            if enabled:
                bucket.discard(tool)
            else:
                bucket.add(tool)
            known = self._seen.setdefault(scope, [])
            if tool not in known:
                known.append(tool)
            self._save()
        self._notify()

    def snapshot(self) -> dict[str, list[dict[str, Any]]]:
        """``{scope: [{"name": str, "enabled": bool}, ...]}`` for every known scope."""
        with self._lock:
            scopes = list(dict.fromkeys([*self._scopes, *self._seen.keys()]))
            return {
                s: [
                    {"name": n, "enabled": n not in self._disabled.get(s, ())}
                    for n in sorted(
                        set(self._seen.get(s, [])) | set(self._disabled.get(s, ())),
                    )
                ]
                for s in scopes
            }

    @property
    def scopes(self) -> list[str]:
        with self._lock:
            return list(self._scopes)

    def on_change(self, fn: Callable[[], None]) -> None:
        self._listeners.append(fn)

    def _notify(self) -> None:
        for fn in list(self._listeners):
            try:
                fn()
            except Exception:
                pass


class ToggleMiddleware(AgentMiddleware[Any, Any, Any]):
    """Hides disabled tools from the model and rejects calls to them."""

    def __init__(self, toggles: ToolToggles, scope: str) -> None:
        super().__init__()
        self._toggles = toggles
        self._scope = scope

    @property
    def name(self) -> str:
        return f"DeepTUIToggles[{self._scope}]"

    # -- model call ---------------------------------------------------------------
    def _filter(self, request: Any) -> Any:
        names = [n for n in (_tool_name(t) for t in request.tools) if n]
        self._toggles.note_tools(self._scope, names)
        kept = [t for t in request.tools if not self._toggles.is_disabled(self._scope, _tool_name(t) or "")]
        if len(kept) != len(request.tools):
            request = request.override(tools=kept)
        return request

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._filter(request))

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return await handler(self._filter(request))

    # -- tool call ----------------------------------------------------------------
    def _rejection(self, request: Any) -> ToolMessage | None:
        name = request.tool_call["name"]
        if not self._toggles.is_disabled(self._scope, name):
            return None
        return ToolMessage(
            content=f"Error: tool '{name}' is disabled by the user right now. Do not call it; use another approach.",
            tool_call_id=request.tool_call["id"] or "",
            name=name,
            status="error",
        )

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return self._rejection(request) or handler(request)

    async def awrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return self._rejection(request) or await handler(request)
