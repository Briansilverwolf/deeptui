"""A keyless demo agent for trying the TUI and for tests.

It uses a scripted fake model, a CompositeBackend, a ``researcher`` subagent and
human-in-the-loop approval on ``write_file``. Try these prompts:

  plan something   -> write_todos
  research cats    -> delegates to the researcher subagent
  write a file     -> asks for approval before writing
  boom             -> the model raises an error (the TUI must survive it)
  slow             -> streams slowly so you can test Stop
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

from deepagents import create_deep_agent
from langchain.agents.middleware import TodoListMiddleware
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.store.memory import InMemoryStore

from . import AgentContext


@tool
def search_web(query: str) -> str:
    """Search the web for a query (fake)."""
    return f"Top results for {query!r}: (1) Wikipedia entry, (2) a very long blog post, (3) a forum thread."


@tool
def get_time() -> str:
    """Return the current time (fake)."""
    return "12:00"


def _last(messages: list[BaseMessage], kind: type) -> BaseMessage | None:
    for m in reversed(messages):
        if isinstance(m, kind):
            return m
    return None


class ScriptedModel(BaseChatModel):
    """Deterministic fake chat model driven by keywords in the latest user message."""

    role: str = "main"
    delay: float = 0.0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    # -- decide what to say ---------------------------------------------------------
    def _plan(self, messages: list[BaseMessage]) -> tuple[str, list[dict[str, Any]]]:
        last = messages[-1] if messages else None
        human = _last(messages, HumanMessage)
        ask = (human.content if human else "") or ""
        ask = ask if isinstance(ask, str) else str(ask)
        low = ask.lower()

        if isinstance(last, ToolMessage):
            if last.status == "error":
                return f"A tool failed ({last.content}). I'll continue without it.", []
            if last.name == "task":
                return f"The researcher reported: {str(last.content)[:200]}", []
            if last.name == "write_file":
                return "Done, the file is written.", []
            if last.name == "write_todos":
                return "I made a plan. Ask me to continue on any step.", []
            if last.name == "search_web":
                return "Findings: cats are mammals that purr. (from search)", []
            return f"Tool {last.name} finished.", []

        if self.role != "main":  # a subagent
            return "", [{"name": "search_web", "args": {"query": ask[:60]}, "id": f"c{uuid.uuid4().hex[:8]}"}]

        if "boom" in low:
            raise RuntimeError("Simulated model failure (401 invalid API key)")
        if "plan" in low:
            todos = [
                {"content": "Understand the goal", "status": "completed"},
                {"content": "Draft the solution", "status": "in_progress"},
                {"content": "Review and ship", "status": "pending"},
            ]
            return "Let me plan this.", [{"name": "write_todos", "args": {"todos": todos}, "id": f"c{uuid.uuid4().hex[:8]}"}]
        if "research" in low:
            return "I'll delegate this to the researcher.", [
                {
                    "name": "task",
                    "args": {"description": ask, "subagent_type": "researcher"},
                    "id": f"c{uuid.uuid4().hex[:8]}",
                }
            ]
        if "write" in low and "file" in low:
            return "I'll save that.", [
                {
                    "name": "write_file",
                    "args": {"file_path": "/notes.md", "content": "# Notes\nHello from the demo agent.\n"},
                    "id": f"c{uuid.uuid4().hex[:8]}",
                }
            ]
        if "slow" in low:
            return " ".join(f"word{i}" for i in range(1, 80)), []
        return f"You said: {ask}. (demo agent, main). I have no real model, but the UI is real.", []

    def _message(self, messages: list[BaseMessage]) -> AIMessage:
        text, calls = self._plan(messages)
        return AIMessage(content=text, tool_calls=calls)

    # -- sync -----------------------------------------------------------------------
    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: CallbackManagerForLLMRun | None = None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._message(messages))])

    def _stream(self, messages: list[BaseMessage], stop: list[str] | None = None,
                run_manager: CallbackManagerForLLMRun | None = None, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        msg = self._message(messages)
        for word in msg.content.split(" ") if msg.content else []:
            yield ChatGenerationChunk(message=AIMessageChunk(content=word + " "))
        if msg.tool_calls:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {"name": c["name"], "args": __import__("json").dumps(c["args"]), "id": c["id"], "index": i}
                        for i, c in enumerate(msg.tool_calls)
                    ],
                )
            )

    # -- async ----------------------------------------------------------------------
    async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                         run_manager: AsyncCallbackManagerForLLMRun | None = None, **kwargs: Any) -> ChatResult:
        return self._generate(messages, stop, None, **kwargs)

    async def _astream(self, messages: list[BaseMessage], stop: list[str] | None = None,
                       run_manager: AsyncCallbackManagerForLLMRun | None = None,
                       **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
        pause = 0.35 if any("slow" in str(getattr(m, "content", "")).lower() for m in messages[-3:]) else self.delay
        for chunk in self._stream(messages, stop, None, **kwargs):
            if pause:
                await asyncio.sleep(pause)
            yield chunk


def build_agent(ctx: AgentContext):
    """Factory the bridge calls. The same shape works for your real agent."""
    backend = CompositeBackend(
        default=StateBackend(),
        routes={"/memories/": StoreBackend(namespace=lambda rt: ("demo", "memories"))},
    )
    researcher = {
        "name": "researcher",
        "description": "Looks things up on the web and reports back.",
        "system_prompt": "You are a careful researcher. Use search_web, then summarise.",
        "model": ScriptedModel(role="researcher"),
        "tools": [search_web],
    }
    return create_deep_agent(
        model=ScriptedModel(),
        tools=[search_web, get_time],
        system_prompt="You are the demo agent for the deepagents TUI.",
        backend=backend,
        subagents=ctx.toggles.attach([researcher], inherited_tools=[search_web, get_time]),
        middleware=[TodoListMiddleware(), ctx.toggles.middleware("main")],
        interrupt_on={"write_file": {"allowed_decisions": ["approve", "edit", "reject"]}},
        checkpointer=ctx.checkpointer,
        store=InMemoryStore(),
        name="main",
    )
