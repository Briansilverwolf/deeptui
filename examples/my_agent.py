"""Template: wire YOUR deepagent into deeptui. Copy this file and edit.

Run:  bun run src/index.tsx path/to/my_agent.py:build_agent   (from the tui folder)
"""
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.store.memory import InMemoryStore  # swap for your real store

from deeptui import AgentContext


def build_agent(ctx: AgentContext):
    backend = CompositeBackend(
        default=StateBackend(),
        routes={"/memories/": StoreBackend(namespace=lambda rt: ("memories",))},
    )
    my_subagents = [
        # {"name": "researcher", "description": "...", "system_prompt": "...", "tools": [...]},
    ]
    return create_deep_agent(
        model="anthropic:claude-sonnet-4-5",          # your model
        tools=[],                                      # your tools
        system_prompt="You are my agent.",
        backend=backend,
        # --- the three lines deeptui needs -------------------------------------
        checkpointer=ctx.checkpointer,                 # conversation survives restarts
        middleware=[ctx.toggles.middleware("main")],   # enable/disable main-agent tools
        subagents=ctx.toggles.attach(my_subagents),    # enable/disable subagent tools
        # -----------------------------------------------------------------------
        store=InMemoryStore(),
        interrupt_on={"write_file": True, "edit_file": True, "execute": True},  # approvals
    )
