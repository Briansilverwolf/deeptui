// Spawns and supervises the Python bridge. It never throws into the UI:
// crashes become "down" events and the bridge is restarted automatically.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { BridgeEvent } from "./state"

export interface ClientOptions {
  target: string
  python?: string
  stateDir: string
  threadId?: string
}

interface Candidate {
  cmd: string
  args: string[]
}

export function defaultStateDir(target: string): string {
  const key = target.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(-60) || "agent"
  return join(process.env.DEEPTUI_HOME || join(homedir(), ".deeptui"), key)
}

function pythonCandidates(explicit?: string): Candidate[] {
  const out: Candidate[] = []
  const add = (cmd: string, args: string[] = []) => out.push({ cmd, args })
  if (explicit) add(explicit)
  if (process.env.DEEPTUI_PYTHON) add(process.env.DEEPTUI_PYTHON)
  const venvs =
    process.platform === "win32"
      ? [join(".venv", "Scripts", "python.exe"), join("venv", "Scripts", "python.exe")]
      : [join(".venv", "bin", "python"), join("venv", "bin", "python")]
  for (const v of venvs) if (existsSync(resolve(v))) add(resolve(v))
  if (process.platform === "win32") {
    add("python")
    add("py", ["-3"])
  } else {
    add("python3")
    add("python")
  }
  return out
}

export class BridgeClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private buf = ""
  private stopping = false
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private candidateIdx = 0
  private candidates: Candidate[]
  private stderrTail: string[] = []
  readonly logs: string[] = []
  private logFile: string
  private threadId?: string

  constructor(private opts: ClientOptions) {
    super()
    this.candidates = pythonCandidates(opts.python)
    this.threadId = opts.threadId
    mkdirSync(opts.stateDir, { recursive: true })
    this.logFile = join(opts.stateDir, "bridge.log")
  }

  // -- lifecycle ----------------------------------------------------------------
  start(): void {
    if (this.child || this.stopping) return
    const cand = this.candidates[this.candidateIdx]
    if (!cand) {
      this.emit("down", { reason: "Could not start Python. Install Python 3.10+ or pass --python <path>.", willRestart: false })
      return
    }
    const here = dirname(fileURLToPath(import.meta.url))
    const pySrc = resolve(here, "..", "..", "src")
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONPATH: [pySrc, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    }
    const args = [...cand.args, "-m", "deeptui.bridge", this.opts.target, "--state-dir", this.opts.stateDir]
    if (this.threadId) args.push("--thread", this.threadId)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(cand.cmd, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams
    } catch (err) {
      this.onSpawnFailure(err as Error)
      return
    }
    this.child = child
    this.buf = ""
    this.stderrTail = []
    let spawned = false

    child.once("spawn", () => {
      spawned = true
    })
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      this.child = null
      if (!spawned && err.code === "ENOENT") {
        this.candidateIdx++
        return this.start() // try the next python candidate
      }
      this.onSpawnFailure(err)
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk))
    child.stdin.on("error", () => {}) // writing to a dead child must not throw
    child.once("exit", (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      const tail = this.stderrTail.slice(-12).join("\n")
      this.failures++
      const willRestart = this.failures <= 5
      this.emit("down", {
        reason: `Agent process exited (${signal ?? `code ${code}`})${tail ? `:\n${tail}` : ""}`,
        willRestart,
      })
      if (willRestart) {
        const delay = Math.min(500 * 2 ** (this.failures - 1), 8000)
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.start()
        }, delay)
      }
    })
    this.emit("starting")
  }

  private onSpawnFailure(err: Error): void {
    this.emit("down", { reason: `Could not start the agent process: ${err.message}`, willRestart: false })
  }

  /** Kill the bridge and start a fresh one (reloads your agent code). */
  restart(threadId?: string): void {
    if (threadId !== undefined) this.threadId = threadId
    this.failures = 0
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const old = this.child
    this.child = null
    if (old) {
      try {
        old.removeAllListeners("exit")
        old.kill()
      } catch {}
    }
    this.start()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const c = this.child
    if (!c) return
    try {
      c.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n")
      c.stdin.end()
    } catch {}
    setTimeout(() => {
      try {
        c.kill()
      } catch {}
    }, 800).unref()
  }

  // -- io -------------------------------------------------------------------------
  send(cmd: Record<string, unknown>): boolean {
    const c = this.child
    if (!c || !c.stdin.writable) return false
    try {
      c.stdin.write(JSON.stringify(cmd) + "\n")
      return true
    } catch {
      return false
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line) as BridgeEvent
        if (ev.type === "ready") this.failures = 0
        this.emit("event", ev)
      } catch {
        this.pushLog(`[bad protocol line] ${line.slice(0, 200)}`)
      }
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue
      this.stderrTail.push(line)
      if (this.stderrTail.length > 100) this.stderrTail.shift()
      this.pushLog(line)
    }
  }

  private pushLog(line: string): void {
    this.logs.push(line)
    if (this.logs.length > 500) this.logs.shift()
    try {
      appendFileSync(this.logFile, line + "\n")
    } catch {}
    this.emit("log", line)
  }
}
