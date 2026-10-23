/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { C, argSummary, clipText, levelColor, prettyArgs } from "./theme"
import type { Action, Interrupt, Item, Todo, ToolToggle } from "./state"

// --------------------------------------------------------------------------- transcript
export function ItemView({ item, expand }: { item: Item; expand: boolean }) {
  if (item.kind === "user") {
    return (
      <box flexDirection="column" marginTop={1}>
        <text fg={item.restored ? C.dim : C.accent}>
          <strong>you</strong>
        </text>
        <text wrapMode="word" fg={item.restored ? C.dim : C.fg}>
          {item.text}
        </text>
      </box>
    )
  }
  if (item.kind === "assistant") {
    const indent = item.depth * 2
    return (
      <box flexDirection="column" marginTop={1} paddingLeft={indent}>
        <text fg={item.depth > 0 ? C.purple : item.restored ? C.dim : C.green}>
          <strong>{item.depth > 0 ? `↳ ${item.agent}` : "agent"}</strong>
          {item.stopped ? <span fg={C.yellow}> (stopped)</span> : null}
          {!item.done && !item.stopped ? <span fg={C.dim}> …</span> : null}
        </text>
        <text wrapMode="word" fg={item.restored ? C.dim : C.fg}>
          {item.text}
        </text>
      </box>
    )
  }
  if (item.kind === "tool") {
    const icon = item.status === "running" ? "◌" : item.status === "ok" ? "✓" : "✗"
    const color = item.status === "running" ? C.yellow : item.status === "ok" ? C.green : C.red
    const indent = item.depth * 2 + 2
    const out = item.output ? (expand ? item.output : clipText(item.output, 100)) : ""
    return (
      <box flexDirection="column" paddingLeft={indent}>
        <text wrapMode="none">
          <span fg={color}>{icon} </span>
          <span fg={C.cyan}>{item.name}</span>
          <span fg={C.dim}> {argSummary(item.args)}</span>
        </text>
        {out ? (
          <text wrapMode="word" fg={item.status === "error" ? C.red : C.faint} paddingLeft={2}>
            {out}
          </text>
        ) : null}
      </box>
    )
  }
  return (
    <box flexDirection="column" marginTop={1}>
      <text wrapMode="word" fg={levelColor(item.level)}>
        {item.level === "error" ? "✗ " : item.level === "warn" ? "! " : "· "}
        {item.text}
      </text>
      {item.detail ? (
        <text wrapMode="word" fg={C.faint} paddingLeft={2}>
          {item.detail}
        </text>
      ) : null}
    </box>
  )
}

// --------------------------------------------------------------------------- todos
export function TodoList({ todos }: { todos: Todo[] }) {
  if (!todos.length) return <text fg={C.dim}>No todos yet. They show up when the agent plans its work.</text>
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <box flexDirection="column">
      <text fg={C.dim}>
        {done}/{todos.length} done
      </text>
      {todos.map((t, i) => {
        const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"
        const color = t.status === "completed" ? C.green : t.status === "in_progress" ? C.yellow : C.dim
        return (
          <text key={i} wrapMode="word" fg={t.status === "completed" ? C.dim : C.fg}>
            <span fg={color}>{icon} </span>
            {t.content}
          </text>
        )
      })}
    </box>
  )
}

export function Sidebar({ todos, width }: { todos: Todo[]; width: number }) {
  return (
    <box width={width} border borderStyle="rounded" borderColor={C.line} title=" Todos " titleAlignment="left" padding={1} flexDirection="column">
      <TodoList todos={todos} />
    </box>
  )
}

// --------------------------------------------------------------------------- generic panel frame
function Frame({ title, hint, children }: { title: string; hint: string; children: any }) {
  return (
    <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={C.accent} title={` ${title} `} padding={1}>
      <box flexGrow={1} flexDirection="column">
        {children}
      </box>
      <text fg={C.dim}>{hint}</text>
    </box>
  )
}

function sortScopes(scopes: string[]): string[] {
  return [...scopes].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))
}

function ScopeTabs({ scopes, index }: { scopes: string[]; index: number }) {
  return (
    <text wrapMode="none">
      {scopes.map((s, i) => (
        <span key={s} fg={i === index ? C.bg : C.dim} bg={i === index ? C.accent : undefined}>
          {` ${s} `}
        </span>
      ))}
    </text>
  )
}

// --------------------------------------------------------------------------- tools panel
export function ToolsPanel(props: {
  tools: Record<string, ToolToggle[]>
  supported: boolean
  onToggle: (scope: string, tool: string, enabled: boolean) => void
  onClose: () => void
}) {
  const { height } = useTerminalDimensions()
  const scopes = sortScopes(Object.keys(props.tools))
  const [si, setSi] = useState(0)
  const [ri, setRi] = useState(0)
  const scope = scopes[Math.min(si, Math.max(0, scopes.length - 1))]
  const rows = (scope && props.tools[scope]) || []

  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") return props.onClose()
    if (k.name === "right" || (k.name === "tab" && !k.shift)) {
      setSi((x) => (scopes.length ? (x + 1) % scopes.length : 0))
      setRi(0)
    } else if (k.name === "left" || (k.name === "tab" && k.shift)) {
      setSi((x) => (scopes.length ? (x - 1 + scopes.length) % scopes.length : 0))
      setRi(0)
    } else if (k.name === "down" || k.name === "j") setRi((x) => Math.min(Math.max(rows.length - 1, 0), x + 1))
    else if (k.name === "up" || k.name === "k") setRi((x) => Math.max(0, x - 1))
    else if ((k.name === "space" || k.name === "return") && scope && rows[ri]) props.onToggle(scope, rows[ri]!.name, !rows[ri]!.enabled)
    else if (k.name === "a" && scope) rows.forEach((r) => !r.enabled && props.onToggle(scope, r.name, true))
    else if (k.name === "n" && scope) rows.forEach((r) => r.enabled && props.onToggle(scope, r.name, false))
  })

  const visible = Math.max(5, height - 11)
  const start = Math.max(0, Math.min(ri - Math.floor(visible / 2), Math.max(0, rows.length - visible)))
  const slice = rows.slice(start, start + visible)
  const off = rows.filter((r) => !r.enabled).length

  return (
    <Frame title="Tools" hint="←/→ agent · ↑/↓ move · Space toggle · a enable all · n disable all · Esc close">
      {!scopes.length ? (
        <text wrapMode="word" fg={C.yellow}>
          {props.supported
            ? "No tools seen yet. Send a message and they will appear."
            : "This agent was not set up for toggling. In your agent factory add middleware=[ctx.toggles.middleware('main')] and subagents=ctx.toggles.attach([...]). See the README."}
        </text>
      ) : (
        <>
          <ScopeTabs scopes={scopes} index={si} />
          <text fg={C.dim}>
            {scope === "main" ? "Main agent" : `Subagent: ${scope}`} · {rows.length - off} on, {off} off · applies from the agent's next step
          </text>
          <box flexDirection="column" marginTop={1}>
            {slice.map((r, i) => {
              const idx = start + i
              const sel = idx === ri
              return (
                <text key={r.name} fg={sel ? C.fg : r.enabled ? C.fg : C.dim} bg={sel ? C.line : undefined}>
                  <span fg={r.enabled ? C.green : C.red}>{r.enabled ? "[x] " : "[ ] "}</span>
                  {r.name}
                  {r.enabled ? "" : "  (disabled)"}
                </text>
              )
            })}
          </box>
        </>
      )}
    </Frame>
  )
}

// --------------------------------------------------------------------------- scrollable text panel
function useScrollKeys(ref: React.RefObject<ScrollBoxRenderable | null>, enabled = true) {
  useKeyboard((k) => {
    if (!enabled) return
    const sb = ref.current
    if (!sb) return
    if (k.name === "down" || k.name === "j") sb.scrollBy(1)
    else if (k.name === "up" || k.name === "k") sb.scrollBy(-1)
    else if (k.name === "pagedown" || k.name === "space") sb.scrollBy(12)
    else if (k.name === "pageup") sb.scrollBy(-12)
    else if (k.name === "home" || k.name === "g") sb.scrollTo(0)
    else if (k.name === "end") sb.scrollTo(1e9)
  })
}

export function PromptPanel(props: { prompts: Record<string, string>; onClose: () => void }) {
  const scopes = sortScopes(Object.keys(props.prompts))
  const [si, setSi] = useState(0)
  const ref = useRef<ScrollBoxRenderable>(null)
  useScrollKeys(ref)
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") return props.onClose()
    if (k.name === "right" || (k.name === "tab" && !k.shift)) setSi((x) => (scopes.length ? (x + 1) % scopes.length : 0))
    if (k.name === "left" || (k.name === "tab" && k.shift)) setSi((x) => (scopes.length ? (x - 1 + scopes.length) % scopes.length : 0))
  })
  useEffect(() => ref.current?.scrollTo(0), [si])
  const scope = scopes[Math.min(si, Math.max(0, scopes.length - 1))]
  return (
    <Frame title="System prompt" hint="←/→ agent · ↑/↓ PgUp/PgDn scroll · Esc close">
      {!scope ? (
        <text wrapMode="word" fg={C.yellow}>
          Not captured yet. The exact prompt is recorded the first time each agent calls the model. Send any message and it will show up here.
        </text>
      ) : (
        <>
          <ScopeTabs scopes={scopes} index={si} />
          <text fg={C.dim}>{props.prompts[scope]!.length} characters, exactly what the model received as the system message</text>
          <scrollbox ref={ref} flexGrow={1} marginTop={1}>
            <text wrapMode="word" fg={C.fg}>
              {props.prompts[scope]}
            </text>
          </scrollbox>
        </>
      )}
    </Frame>
  )
}

export function LogsPanel({ lines, onClose }: { lines: string[]; onClose: () => void }) {
  const ref = useRef<ScrollBoxRenderable>(null)
  useScrollKeys(ref)
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") onClose()
  })
  return (
    <Frame title="Agent logs (stderr)" hint="↑/↓ PgUp/PgDn scroll · Esc close · full log: bridge.log in the state folder">
      <scrollbox ref={ref} flexGrow={1} stickyScroll stickyStart="bottom">
        {lines.length ? (
          lines.slice(-300).map((l, i) => (
            <text key={i} wrapMode="char" fg={C.dim}>
              {l}
            </text>
          ))
        ) : (
          <text fg={C.dim}>Nothing logged yet. Anything your agent prints lands here.</text>
        )}
      </scrollbox>
    </Frame>
  )
}

export function TodosPanel({ todos, onClose }: { todos: Todo[]; onClose: () => void }) {
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") onClose()
  })
  return (
    <Frame title="Todos" hint="Esc close">
      <TodoList todos={todos} />
    </Frame>
  )
}

export function HelpPanel({ onClose }: { onClose: () => void }) {
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q" || k.name === "return") onClose()
  })
  const rows: [string, string][] = [
    ["Enter", "send message"],
    ["Shift+Enter / Ctrl+J", "new line in the message"],
    ["Esc or Ctrl+C", "stop the agent while it works"],
    ["Ctrl+R", "continue an unfinished turn, or resend your last message"],
    ["Ctrl+T", "enable / disable tools (main agent and subagents)"],
    ["Ctrl+G", "view the system prompt of each agent"],
    ["Ctrl+O", "todos (always visible on wide terminals)"],
    ["Ctrl+E", "expand / collapse tool output"],
    ["Ctrl+L", "agent logs (stderr)"],
    ["Ctrl+N", "start a new conversation (press twice)"],
    ["Ctrl+K", "restart the agent process (reloads your code)"],
    ["PgUp / PgDn", "scroll the conversation"],
    ["Ctrl+Q or Ctrl+C twice", "quit"],
    ["/help /tools /prompt /todos /logs /retry /stop /new /reload /history N /quit", "slash commands"],
  ]
  return (
    <Frame title="Help" hint="Esc close">
      {rows.map(([k, v]) => (
        <text key={k} wrapMode="word">
          <span fg={C.accent}>{k.padEnd(26)}</span>
          <span fg={C.fg}> {v}</span>
        </text>
      ))}
    </Frame>
  )
}

// --------------------------------------------------------------------------- fatal
export function FatalPanel({ fatal }: { fatal: { message: string; trace?: string } }) {
  return (
    <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={C.red} title=" Your agent failed to load " padding={1}>
      <text wrapMode="word" fg={C.red}>
        {fatal.message}
      </text>
      <text wrapMode="char" fg={C.dim} marginTop={1}>
        {(fatal.trace ?? "").split("\n").slice(-14).join("\n")}
      </text>
      <text fg={C.yellow} marginTop={1}>
        Fix the problem in your code, then press Ctrl+K to reload. Ctrl+L shows logs.
      </text>
    </box>
  )
}

// --------------------------------------------------------------------------- approvals
type Decision = { type: "approve" } | { type: "reject"; message?: string } | { type: "edit"; edited_action: { name: string; args: unknown } } | { type: "respond"; message: string } | { type: "value"; value: string }

export function Approval(props: { pending: Interrupt[]; onResolve: (d: Decision[]) => void }) {
  type Flat = { kind: "hitl"; a: Action; value?: undefined } | { kind: "value"; a: null; value: unknown }
  const flat: Flat[] = []
  for (const p of props.pending) {
    if (p.kind === "hitl") for (const a of p.actions) flat.push({ kind: "hitl", a })
    else flat.push({ kind: "value", a: null, value: p.value })
  }
  const [idx, setIdx] = useState(0)
  const [mode, setMode] = useState<"choose" | "edit" | "reject" | "answer">("choose")
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [err, setErr] = useState<string | null>(null)
  const ta = useRef<TextareaRenderable>(null)
  const { height: termH } = useTerminalDimensions()
  const argLines = Math.max(3, Math.min(12, termH - 19))
  const cur = flat[idx]

  const record = (d: Decision) => {
    const next = [...decisions, d]
    if (next.length >= flat.length) return props.onResolve(next)
    setDecisions(next)
    setIdx(idx + 1)
    setMode(flat[idx + 1]?.kind === "value" ? "answer" : "choose")
    setErr(null)
  }

  useEffect(() => {
    if (cur?.kind === "value") setMode("answer")
  }, [idx])

  useKeyboard((k) => {
    if (!cur) return
    if (mode !== "choose") {
      if (k.name === "escape" && cur.kind === "hitl") {
        setMode("choose")
        setErr(null)
      }
      return
    }
    const allowed = cur.a?.allowed ?? []
    if (k.name === "y" && allowed.includes("approve")) record({ type: "approve" })
    else if (k.name === "n" && allowed.includes("reject")) setMode("reject")
    else if (k.name === "e" && allowed.includes("edit")) setMode("edit")
    else if (k.name === "a") {
      // approve all remaining
      const rest = flat.slice(idx).map(() => ({ type: "approve" }) as Decision)
      if (flat.slice(idx).every((f) => f.kind === "hitl" && f.a.allowed.includes("approve"))) props.onResolve([...decisions, ...rest])
    }
  })

  const submit = () => {
    const text = ta.current?.plainText ?? ""
    if (!cur) return
    if (mode === "reject") return record(text.trim() ? { type: "reject", message: text.trim() } : { type: "reject" })
    if (mode === "answer") return record({ type: "value", value: text })
    if (mode === "edit" && cur.a) {
      try {
        const args = JSON.parse(text)
        record({ type: "edit", edited_action: { name: cur.a.name, args } })
      } catch (e) {
        setErr(`That is not valid JSON: ${(e as Error).message}`)
      }
    }
  }

  const keys = [
    { name: "return" as const, action: "submit" as const },
    { name: "return" as const, shift: true, action: "newline" as const },
    { name: "j" as const, ctrl: true, action: "newline" as const },
  ]

  const title = flat.length > 1 ? ` Approval needed (${idx + 1}/${flat.length}) ` : " Approval needed "
  return (
    <box border borderStyle="rounded" borderColor={C.yellow} title={title} paddingLeft={1} paddingRight={1} flexDirection="column" flexShrink={0}>
      {cur?.kind === "hitl" && cur.a ? (
        <>
          <text wrapMode="word">
            <span fg={C.yellow}>The agent wants to run </span>
            <span fg={C.cyan}>
              <strong>{cur.a.name}</strong>
            </span>
          </text>
          {cur.a.description && !/Args:/.test(cur.a.description) ? (
            <text wrapMode="none" fg={C.dim}>
              {clipText(cur.a.description, 100)}
            </text>
          ) : null}
          <text wrapMode="char" fg={C.fg}>
            {prettyArgs(cur.a.args, mode === "edit" ? 3 : argLines)}
          </text>
        </>
      ) : (
        <text wrapMode="word" fg={C.fg}>
          {typeof cur?.value === "string" ? cur.value : prettyArgs(cur?.value)}
        </text>
      )}
      {mode === "choose" ? (
        <text wrapMode="word">
          <span fg={C.green}>y</span>
          <span fg={C.dim}> approve · </span>
          {cur?.a?.allowed.includes("reject") ? (
            <>
              <span fg={C.red}>n</span>
              <span fg={C.dim}> reject · </span>
            </>
          ) : null}
          {cur?.a?.allowed.includes("edit") ? (
            <>
              <span fg={C.yellow}>e</span>
              <span fg={C.dim}> edit args · </span>
            </>
          ) : null}
          {flat.length - idx > 1 ? (
            <>
              <span fg={C.green}>a</span>
              <span fg={C.dim}> approve all</span>
            </>
          ) : null}
        </text>
      ) : (
        <box flexDirection="column">
          <text fg={C.dim}>
            {mode === "reject" ? "Why? (optional) Enter to reject, Esc to go back" : mode === "edit" ? "Edit the arguments as JSON. Enter to approve with changes, Esc to go back" : "Your answer. Enter to send"}
          </text>
          <box border borderStyle="single" borderColor={C.line} height={mode === "edit" ? 5 : 3} flexShrink={0}>
            <textarea
              ref={ta}
              focused
              initialValue={mode === "edit" && cur?.a ? JSON.stringify(cur.a.args) : ""}
              keyBindings={keys}
              onSubmit={submit}
              textColor={C.fg}
              focusedTextColor={C.fg}
              wrapMode="char"
            />
          </box>
          {err ? <text fg={C.red}>{err}</text> : null}
        </box>
      )}
    </box>
  )
}
