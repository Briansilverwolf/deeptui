"""What the bridge hands to your agent factory."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .toggles import ToolToggles


@dataclass
class AgentContext:
    """Passed to ``build_agent(ctx)``.

    Attributes:
        checkpointer: Pass to ``create_deep_agent(checkpointer=...)``. Persists the
            conversation so the TUI can restore it after a restart.
        toggles: Use ``ctx.toggles.middleware("main")`` and ``ctx.toggles.attach(...)``
            to make tools switchable from the TUI.
        state_dir: Folder where the TUI keeps its files. Handy for your own state too.
    """

    checkpointer: Any
    toggles: ToolToggles
    state_dir: Path
    extra: dict[str, Any] = field(default_factory=dict)
