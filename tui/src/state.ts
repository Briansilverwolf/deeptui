// UI state + reducer. Everything the screen shows is derived from bridge events.

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" | string }
export type ToolToggle = { name: string; enabled: boolean }
export type Action = { name: string; args: Record<string, unknown>; description?: string; allowed: string[] }
export type Interrupt = { id: string; kind: "hitl" | "value"; actions: Action[]; value?: unknown }

export type Item =
  | { kind: "user"; id: string; text: string; restored?: boolean }
  | {
      kind: "assistant"
      id: string
      key: string
      agent: string
      depth: number
      text: string
      done: boolean
      stopped?: boolean
      restored?: boolean
    }
  | {
      kind: "tool"
      id: string
      callId: string
      name: string
      args: unknown
      agent: string
      depth: number
      status: "running" | "ok" | "error"
      output?: string
    }
  | { kind: "note"; id: string; level: "info" | "warn" | "error"; text: string; detail?: string }

export type Banner = { level: "info" | "warn" | "error"; text: string } | null
export type Conn = "starting" | "ready" | "restarting" | "down"

export interface UIState {
  items: Item[]
  conn: Conn
  fatal: { message: string; trace?: string } | null
  busy: boolean
  threadId: string | null
  agent: string | null
  togglesSupported: boolean
  todos: Todo[]
  tools: Record<string, ToolToggle[]>
  prompts: Record<string, string>
  pending: Interrupt[] | null
  banner: Banner
  seq: number
  runStartedAt: number | null
}

export const initialState: UIState = {
  items: [],
  conn: "starting",
  fatal: null,
  busy: false,
  threadId: null,
  agent: null,
  togglesSupported: false,
  todos: [],
  tools: {},
  prompts: {},
  pending: null,
  banner: null,
  seq: 0,
  runStartedAt: null,
}

export type BridgeEvent = { type: string; [k: string]: any }
export type Msg =
  | { t: "events"; events: BridgeEvent[] }
  | { t: "conn"; conn: Conn }
  | { t: "bridge_down"; reason: string; willRestart: boolean }
  | { t: "note"; level: "info" | "warn" | "error"; text: string; detail?: string }
  | { t: "banner"; banner: Banner }

const MAX_ITEMS = 600

function nid(s: UIState): [string, UIState] {
  const seq = s.seq + 1
  return [`i${seq}`, { ...s, seq }]
}

function push(s: UIState, make: (id: string) => Item): UIState {
  const [id, s2] = nid(s)
  const items = [...s2.items, make(id)]
  return { ...s2, items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items }
}

function mapLast<T extends Item>(items: Item[], pred: (i: Item) => i is T, fn: (i: T) => Item): Item[] | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!
    if (pred(it)) {
      const copy = items.slice()
      copy[k] = fn(it)
      return copy
    }
  }
  return null
}

const isAssistant = (i: Item): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant"
const isTool = (i: Item): i is Extract<Item, { kind: "tool" }> => i.kind === "tool"

export function apply(s: UIState, e: BridgeEvent): UIState {
  switch (e.type) {
    case "ready":
      return {
        ...s,
        items: [],
        conn: "ready",
        fatal: null,
        busy: false,
        threadId: e.thread_id ?? null,
        agent: e.agent ?? null,
        togglesSupported: !!e.toggles_supported,
        todos: [],
        pending: null,
        banner:
          s.conn === "restarting"
            ? { level: "warn", text: "The agent process crashed and was restarted. Your conversation was restored from disk." }
            : null,
      }
    case "fatal":
      return { ...s, fatal: { message: e.message, trace: e.trace }, conn: "ready", busy: false }
    case "history": {
      const msgs: any[] = e.messages ?? []
      let n = s
      const hidden = Math.max(0, (e.total ?? msgs.length) - msgs.length)
      if (hidden > 0)
        n = push(n, (id) => ({ kind: "note", id, level: "info", text: `${hidden} earlier message${hidden === 1 ? "" : "s"} not shown` }))
      for (const m of msgs) {
        n =
          m.role === "user"
            ? push(n, (id) => ({ kind: "user", id, text: m.text, restored: true }))
            : push(n, (id) => ({
                kind: "assistant",
                id,
                key: `h-${m.id ?? id}`,
                agent: "main",
                depth: 0,
                text: m.text,
                done: true,
                restored: true,
              }))
      }
      if (msgs.length)
        n = push(n, (id) => ({
          kind: "note",
          id,
          level: "info",
          text: `Restored the last ${msgs.length} message${msgs.length === 1 ? "" : "s"} of this conversation`,
        }))
      return n
    }
    case "state":
      return { ...s, busy: !!e.busy, runStartedAt: e.busy ? (s.runStartedAt ?? Date.now()) : null }
    case "user_message":
      return push({ ...s, banner: null }, (id) => ({ kind: "user", id, text: e.text }))
    case "delta": {
      const key = `${e.agent}|${e.id ?? "x"}`
      const items = mapLast(
        s.items,
        (i): i is Extract<Item, { kind: "assistant" }> => isAssistant(i) && i.key === key && !i.done,
        (i) => ({ ...i, text: i.text + e.text }),
      )
      if (items) return { ...s, items }
      return push(s, (id) => ({
        kind: "assistant",
        id,
        key,
        agent: e.agent ?? "main",
        depth: e.depth ?? 0,
        text: e.text,
        done: false,
      }))
    }
    case "ai_done": {
      const key = `${e.agent}|${e.id ?? "x"}`
      const text: string = (e.text ?? "").trim()
      const items = mapLast(
        s.items,
        (i): i is Extract<Item, { kind: "assistant" }> => isAssistant(i) && i.key === key,
        (i) => ({ ...i, text: text || i.text, done: true }),
      )
      if (items) return { ...s, items }
      if (!text) return s
      return push(s, (id) => ({
        kind: "assistant",
        id,
        key,
        agent: e.agent ?? "main",
        depth: e.depth ?? 0,
        text,
        done: true,
      }))
    }
    case "tool_start":
      if (s.items.some((i) => i.kind === "tool" && i.callId === e.id)) return s
      return push(s, (id) => ({
        kind: "tool",
        id,
        callId: e.id,
        name: e.name ?? "tool",
        args: e.args,
        agent: e.agent ?? "main",
        depth: e.depth ?? 0,
        status: "running",
      }))
    case "tool_end": {
      const items = mapLast(
        s.items,
        (i): i is Extract<Item, { kind: "tool" }> => isTool(i) && i.callId === e.id,
        (i) => ({ ...i, status: e.ok ? "ok" : "error", output: e.output }),
      )
      if (items) return { ...s, items }
      return push(s, (id) => ({
        kind: "tool",
        id,
        callId: e.id,
        name: e.name ?? "tool",
        args: undefined,
        agent: e.agent ?? "main",
        depth: e.depth ?? 0,
        status: e.ok ? "ok" : "error",
        output: e.output,
      }))
    }
    case "todos":
      return { ...s, todos: Array.isArray(e.todos) ? e.todos : [] }
    case "tools":
      return { ...s, tools: e.scopes ?? {} }
    case "system_prompts":
      return { ...s, prompts: e.prompts ?? {} }
    case "interrupt":
      return { ...s, pending: e.items ?? null, banner: { level: "warn", text: "Waiting for your approval" } }
    case "interrupt_resolved":
      return { ...s, pending: null, banner: null }
    case "run_end": {
      // nothing is streaming any more; tools that never finished are marked interrupted
      const items = s.items.map((i): Item => {
        if (i.kind === "assistant" && !i.done) return { ...i, done: true, stopped: e.status !== "ok" }
        if (i.kind === "tool" && i.status === "running" && e.status !== "ok" && !s.pending)
          return { ...i, status: "error", output: i.output ?? "interrupted" }
        return i
      })
      let n: UIState = { ...s, items }
      if (e.status === "cancelled")
        n = {
          ...push(n, (id) => ({ kind: "note", id, level: "warn", text: "Stopped. Ctrl+R continues this turn, or just type a new message." })),
        }
      return n
    }
    case "error":
      return {
        ...push(s, (id) => ({
          kind: "note",
          id,
          level: "error",
          text: e.message ?? "Agent error",
          detail: "Full traceback: Ctrl+L",
        })),
        banner: { level: "error", text: "That turn failed. Ctrl+R retries it, or type a new message." },
      }
    case "unfinished": {
      const text = e.last_error
        ? `The last turn failed (${String(e.last_error).slice(0, 80)}). Ctrl+R continues it.`
        : "The last turn did not finish. Ctrl+R continues it, or type a new message."
      const keep = s.banner && /restarted/.test(s.banner.text) ? `${s.banner.text} ` : ""
      return { ...s, banner: { level: "warn", text: keep + text } }
    }
    case "rejected":
      return { ...s, banner: { level: "warn", text: e.reason } }
    case "info":
      return push(s, (id) => ({ kind: "note", id, level: "info", text: e.message }))
    case "warning":
      return push(s, (id) => ({ kind: "note", id, level: "warn", text: e.message }))
    default:
      return s
  }
}

export function reduce(s: UIState, m: Msg): UIState {
  switch (m.t) {
    case "events":
      return m.events.reduce(apply, s)
    case "conn":
      return { ...s, conn: m.conn }
    case "bridge_down": {
      const items = s.items.map((i): Item => {
        if (i.kind === "assistant" && !i.done) return { ...i, done: true, stopped: true }
        if (i.kind === "tool" && i.status === "running") return { ...i, status: "error", output: "agent process stopped" }
        return i
      })
      return {
        ...push({ ...s, items }, (id) => ({ kind: "note", id, level: "error", text: m.reason })),
        conn: m.willRestart ? "restarting" : "down",
        busy: false,
        runStartedAt: null,
        pending: null,
        banner: {
          level: "error",
          text: m.willRestart
            ? "The agent process crashed. Restarting it. Your conversation is saved."
            : "The agent process keeps crashing. Press Ctrl+L to see logs, fix the problem, then Ctrl+K to restart.",
        },
      }
    }
    case "note":
      return push(s, (id) => ({ kind: "note", id, level: m.level, text: m.text, detail: m.detail }))
    case "banner":
      return { ...s, banner: m.banner }
  }
}
