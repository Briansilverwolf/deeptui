/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import type { BridgeClient } from "./client"
import { initialState, reduce, type BridgeEvent } from "./state"
import { C, levelColor, shortId } from "./theme"
import { Approval, FatalPanel, HelpPanel, ItemView, LogsPanel, Sidebar, TodosPanel, ToolsPanel, PromptPanel } from "./views"

type View = "chat" | "tools" | "prompt" | "todos" | "logs" | "help"
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const INPUT_KEYS = [
  { name: "return" as const, action: "submit" as const },
  { name: "return" as const, shift: true, action: "newline" as const },
  { name: "return" as const, meta: true, action: "newline" as const },
  { name: "j" as const, ctrl: true, action: "newline" as const },
]

export function App({ client, onQuit }: { client: BridgeClient; onQuit: () => void }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const [view, setView] = useState<View>("chat")
  const [expand, setExpand] = useState(false)
  const [frame, setFrame] = useState(0)
  const [inputLines, setInputLines] = useState(1)
  const [armed, setArmed] = useState<null | "quit" | "new">(null)
  const { width, height } = useTerminalDimensions()
  const taRef = useRef<TextareaRenderable>(null)
  const sbRef = useRef<ScrollBoxRenderable>(null)
  const draft = useRef("")
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const logsRef = useRef<string[]>([])
  const [logTick, setLogTick] = useState(0)

  // ---- bridge wiring (events are batched to ~30 fps so streaming stays smooth) ----
  useEffect(() => {
    let queue: BridgeEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      if (!queue.length) return
      const events = queue
      queue = []
      dispatch({ t: "events", events })
    }
    const onEvent = (e: BridgeEvent) => {
      queue.push(e)
      if (!timer) timer = setTimeout(flush, 30)
    }
    const onDown = (d: { reason: string; willRestart: boolean }) => {
      flush()
      dispatch({ t: "bridge_down", reason: d.reason, willRestart: d.willRestart })
    }
    const onLog = () => setLogTick((x) => x + 1)
    client.on("event", onEvent)
    client.on("down", onDown)
    client.on("log", onLog)
    logsRef.current = client.logs
    client.start()
    return () => {
      client.off("event", onEvent)
      client.off("down", onDown)
      client.off("log", onLog)
      if (timer) clearTimeout(timer)
    }
  }, [client])

  // spinner
  useEffect(() => {
    if (!state.busy && state.conn === "ready") return
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 110)
    return () => clearInterval(t)
  }, [state.busy, state.conn])

  const note = useCallback((level: "info" | "warn" | "error", text: string) => dispatch({ t: "note", level, text }), [])
  const banner = useCallback((level: "info" | "warn" | "error", text: string) => dispatch({ t: "banner", banner: { level, text } }), [])

  const send = useCallback(
    (cmd: Record<string, unknown>) => {
      if (!client.send(cmd)) banner("error", "The agent process is not running. Ctrl+K restarts it.")
    },
    [client, banner],
  )

  const arm = (what: "quit" | "new", msg: string) => {
    setArmed(what)
    banner("warn", msg)
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => {
      setArmed(null)
      dispatch({ t: "banner", banner: null })
    }, 2000)
  }

  const actions = {
    stop: () => send({ cmd: "cancel" }),
    retry: () => send({ cmd: "retry" }),
    reload: () => {
      dispatch({ t: "conn", conn: "restarting" })
      client.restart()
    },
    newThread: () => {
      if (armed === "new") {
        setArmed(null)
        send({ cmd: "new_thread" })
      } else arm("new", "Press Ctrl+N again to start a fresh conversation (the current one stays on disk).")
    },
    quit: () => onQuit(),
  }

  const handleInput = (text: string): boolean => {
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).trim().split(/\s+/)
      switch ((cmd ?? "").toLowerCase()) {
        case "help":
        case "?":
          setView("help")
          return true
        case "tools":
          setView("tools")
          return true
        case "prompt":
        case "system":
          setView("prompt")
          return true
        case "todos":
          setView("todos")
          return true
        case "logs":
          setView("logs")
          return true
        case "retry":
        case "resend":
          actions.retry()
          return true
        case "stop":
          actions.stop()
          return true
        case "new":
          send({ cmd: "new_thread" })
          return true
        case "reload":
          actions.reload()
          return true
        case "history": {
          const n = Math.max(1, Math.min(50, parseInt(rest[0] ?? "5", 10) || 5))
          send({ cmd: "history", n })
          return true
        }
        case "quit":
        case "exit":
          actions.quit()
          return true
        default:
          banner("warn", `Unknown command /${cmd}. Try /help.`)
          return false
      }
    }
    if (state.busy) {
      banner("warn", "The agent is still working. Press Esc to stop it first (your text is kept).")
      return false
    }
    send({ cmd: "send", text })
    return true
  }

  const submit = () => {
    const ta = taRef.current
    if (!ta) return
    const text = ta.plainText.trim()
    if (!text) return
    if (handleInput(text)) {
      ta.setText("")
      draft.current = ""
      setInputLines(1)
    }
  }

  // ---- global keys (only active in the chat view; overlays handle their own) ----
  useKeyboard((k) => {
    if (view !== "chat") return
    const sb = sbRef.current
    if (k.name === "pageup") return void sb?.scrollBy(-Math.max(5, height - 10))
    if (k.name === "pagedown") return void sb?.scrollBy(Math.max(5, height - 10))
    if (k.name === "f1") return setView("help")
    if (k.ctrl) {
      switch (k.name) {
        case "c":
          if (state.busy) return actions.stop()
          if (taRef.current?.plainText) {
            taRef.current.setText("")
            draft.current = ""
            return setInputLines(1)
          }
          if (armed === "quit") return actions.quit()
          return arm("quit", "Press Ctrl+C again to quit.")
        case "q":
          return actions.quit()
        case "r":
          return actions.retry()
        case "t":
          return setView("tools")
        case "g":
          return setView("prompt")
        case "o":
          return setView("todos")
        case "l":
          return setView("logs")
        case "e":
          return setExpand((x) => !x)
        case "n":
          return actions.newThread()
        case "k":
          return actions.reload()
      }
      return
    }
    if (k.name === "escape" && state.busy) actions.stop()
  })

  const close = useCallback(() => setView("chat"), [])
  const wide = width >= 110
  const elapsed = state.runStartedAt ? Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000)) : 0

  // ---- pieces ------------------------------------------------------------------
  const overlay =
    view === "tools" ? (
      <ToolsPanel
        tools={state.tools}
        supported={state.togglesSupported}
        onToggle={(scope, tool, enabled) => send({ cmd: "set_tool", scope, tool, enabled })}
        onClose={close}
      />
    ) : view === "prompt" ? (
      <PromptPanel prompts={state.prompts} onClose={close} />
    ) : view === "todos" ? (
      <TodosPanel todos={state.todos} onClose={close} />
    ) : view === "logs" ? (
      <LogsPanel lines={logsRef.current.slice()} onClose={close} />
    ) : view === "help" ? (
      <HelpPanel onClose={close} />
    ) : null

  const hint = state.pending
    ? "y approve · n reject · e edit"
    : state.busy
      ? "Esc stop"
      : "Enter send · ^R retry · ^T tools · ^G prompt · F1 help"

  const connLabel =
    state.conn === "ready"
      ? state.busy
        ? `${SPIN[frame]} working ${elapsed}s`
        : "● ready"
      : state.conn === "starting"
        ? `${SPIN[frame]} starting agent…`
        : state.conn === "restarting"
          ? `${SPIN[frame]} restarting agent…`
          : "✗ agent stopped"
  const connColor = state.conn === "ready" ? (state.busy ? C.yellow : C.green) : state.conn === "down" ? C.red : C.yellow

  const inputHeight = Math.min(8, Math.max(1, inputLines)) + 2
  const canType = !state.fatal && !state.pending && state.conn !== "down"

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={C.bg}>
      <box height={1} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={C.accent} wrapMode="none">
          <strong>◆ deeptui</strong>
          <span fg={C.dim}>
            {"  "}
            {state.agent ?? "starting…"}
            {state.threadId ? `  ·  thread ${shortId(state.threadId)}` : ""}
          </span>
        </text>
      </box>

      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" flexGrow={1}>
          {overlay ?? (
            <>
              {state.fatal ? (
                <FatalPanel fatal={state.fatal} />
              ) : (
                <scrollbox ref={sbRef} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
                  {state.items.length === 0 ? (
                    <text fg={C.dim} marginTop={1}>
                      {state.conn === "ready" ? "New conversation. Say something. (F1 for help)" : "Starting your agent…"}
                    </text>
                  ) : null}
                  {state.items.map((it) => (
                    <ItemView key={it.id} item={it} expand={expand} />
                  ))}
                </scrollbox>
              )}
              {state.banner ? (
                <box paddingLeft={1} paddingRight={1} flexShrink={0}>
                  <text wrapMode="word" fg={levelColor(state.banner.level)}>
                    {state.banner.text}
                  </text>
                </box>
              ) : null}
              {state.pending ? (
                <Approval
                  pending={state.pending}
                  onResolve={(decisions) => send({ cmd: "resume", decisions })}
                />
              ) : (
                <box
                  border
                  borderStyle="rounded"
                  borderColor={state.busy ? C.faint : C.accent}
                  height={inputHeight}
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  title={state.busy ? " agent is working. Esc stops it " : " message "}
                >
                  <textarea
                    ref={taRef}
                    focused={canType}
                    initialValue={draft.current}
                    keyBindings={INPUT_KEYS}
                    onSubmit={submit}
                    onContentChange={() => {
                      const ta = taRef.current
                      if (!ta) return
                      draft.current = ta.plainText
                      setInputLines(Math.max(1, ta.virtualLineCount))
                    }}
                    placeholder={state.fatal ? "Fix your agent, then Ctrl+K" : "Message the agent… (Enter sends, Shift+Enter for a new line)"}
                    placeholderColor={C.faint}
                    textColor={C.fg}
                    focusedTextColor={C.fg}
                    wrapMode="word"
                  />
                </box>
              )}
            </>
          )}
        </box>
        {wide && view === "chat" ? <Sidebar todos={state.todos} width={Math.min(42, Math.floor(width * 0.28))} /> : null}
      </box>

      <box height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
        <text fg={connColor} wrapMode="none">
          {connLabel}
        </text>
        <text fg={C.dim} wrapMode="none">
          {hint}
        </text>
      </box>
    </box>
  )
}
