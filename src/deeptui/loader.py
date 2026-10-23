"""Load the user's agent from ``module:attr`` or ``path/to/file.py:attr``."""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

DEFAULT_ATTRS = ("build_agent", "create_agent", "agent", "graph")


def split_target(target: str) -> tuple[str, str | None]:
    """Split ``target`` into (module-or-path, attr). Windows drive letters are handled."""
    head, sep, tail = target.rpartition(":")
    if sep and head and len(head) > 1 and tail and not any(c in tail for c in "\\/"):
        return head, tail
    return target, None


def import_target(module_or_path: str) -> ModuleType:
    try:  # best effort: a .env next to the project makes API keys just work
        from dotenv import load_dotenv  # type: ignore

        load_dotenv()
    except Exception:
        pass

    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)

    p = Path(module_or_path)
    if module_or_path.endswith(".py") or p.exists():
        p = p.resolve()
        if not p.exists():
            raise FileNotFoundError(f"Agent file not found: {p}")
        parent = str(p.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)
        spec = importlib.util.spec_from_file_location(p.stem, p)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot import {p}")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[p.stem] = mod
        spec.loader.exec_module(mod)
        return mod
    return importlib.import_module(module_or_path)


def is_compiled_graph(obj: Any) -> bool:
    return hasattr(obj, "astream") and hasattr(obj, "aget_state")


async def build(target: str, ctx: Any) -> tuple[Any, str]:
    """Return (compiled agent, display name)."""
    mod_name, attr = split_target(target)
    mod = import_target(mod_name)
    if attr is None:
        attr = next((a for a in DEFAULT_ATTRS if hasattr(mod, a)), None)
        if attr is None:
            raise AttributeError(
                f"{mod_name} has none of {DEFAULT_ATTRS}. Use '{mod_name}:your_factory'."
            )
    obj = getattr(mod, attr)
    name = f"{Path(mod_name).stem if mod_name.endswith('.py') else mod_name}:{attr}"

    if is_compiled_graph(obj):
        agent = obj
    elif callable(obj):
        try:
            params = [
                p
                for p in inspect.signature(obj).parameters.values()
                if p.default is inspect.Parameter.empty
                and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
            ]
        except (TypeError, ValueError):
            params = []
        agent = obj(ctx) if params else obj()
        if inspect.isawaitable(agent):
            agent = await agent
    else:
        raise TypeError(f"{name} is neither a compiled agent nor a factory function")

    if not is_compiled_graph(agent):
        raise TypeError(f"{name} did not produce a compiled LangGraph agent (got {type(agent).__name__})")
    if getattr(agent, "checkpointer", None) in (None, False):
        try:
            agent.checkpointer = ctx.checkpointer
        except Exception as e:  # pragma: no cover
            raise RuntimeError(
                "Your agent has no checkpointer and one could not be attached. "
                "Pass checkpointer=ctx.checkpointer to create_deep_agent()."
            ) from e
    return agent, name
