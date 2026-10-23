#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { App } from "./App"
import { BridgeClient, defaultStateDir } from "./client"

const HELP = `deeptui: a terminal UI for your Python deepagents agent

Usage:
  deeptui <agent> [options]

  <agent>   module:attr or path/to/agent.py:attr
            attr is a function taking ctx (see README), a zero-arg factory, or a compiled agent

Options:
  --python <path>     Python to use (default: ./.venv, then python / python3)
  --state-dir <dir>   Where conversation + settings are kept (default ~/.deeptui/<agent>)
  --thread <id>       Open a specific conversation id
  --new               Start a fresh conversation
  -h, --help          Show this help
`

function parseArgs(argv: string[]) {
  const o: { target?: string; python?: string; stateDir?: string; thread?: string; help?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "-h" || a === "--help") o.help = true
    else if (a === "--python") o.python = argv[++i]
    else if (a === "--state-dir") o.stateDir = argv[++i]
    else if (a === "--thread") o.thread = argv[++i]
    else if (a === "--new") o.thread = randomUUID()
    else if (!a.startsWith("-") && !o.target) o.target = a
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.target) {
  console.log(HELP)
  process.exit(args.help ? 0 : 1)
}

const stateDir = args.stateDir ?? defaultStateDir(args.target!)
mkdirSync(stateDir, { recursive: true })
const tuiLog = join(stateDir, "tui.log")
const log = (msg: string) => {
  try {
    appendFileSync(tuiLog, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// The UI must survive anything: log and carry on.
process.on("uncaughtException", (e) => log(`uncaughtException: ${(e as Error)?.stack ?? e}`))
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${(e as Error)?.stack ?? e}`))

const client = new BridgeClient({ target: args.target!, python: args.python, stateDir, threadId: args.thread })
const renderer = await createCliRenderer({ exitOnCtrlC: false })

let quitting = false
const quit = () => {
  if (quitting) return
  quitting = true
  client.stop()
  try {
    renderer.destroy()
  } catch {}
  setTimeout(() => process.exit(0), 300)
}
process.on("SIGINT", () => {})
process.on("SIGTERM", quit)

createRoot(renderer).render(<App client={client} onQuit={quit} />)
