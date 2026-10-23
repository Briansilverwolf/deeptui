/** @jsxImportSource @opentui/react */
// Drives the real TUI (headless terminal) against the real Python bridge + demo agent.
const origError = console.error
console.error = (...a: unknown[]) => {
  if (String(a[0]).includes("wrapped in act")) return // test-harness noise only
  origError(...a)
}
import { testRender } from "@opentui/react/test-utils"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { App } from "../src/App"
import { BridgeClient } from "../src/client"

const root = resolve(import.meta.dir, "..", "..")
const python = process.env.DEEPTUI_PYTHON ?? join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const stateDir = mkdtempSync(join(tmpdir(), "deeptui-"))
const target = "deeptui.demo_agent:build_agent"
const verbose = process.env.VERBOSE === "1"

let failures = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function session(label: string, fn: (h: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>) {
  const h = await makeHarness()
  console.log(`\n=== ${label}`)
  try {
    await fn(h)
  } catch (e) {
    failures++
    console.log("  ✗ FAILED:", (e as Error).message)
    console.log(h.frame())
  } finally {
    h.client.stop()
    await h.setup.dispose()
  }
}

async function makeHarness() {
  const client = new BridgeClient({ target, python, stateDir })
  const setup = await testRender(<App client={client} onQuit={() => {}} />, { width: 120, height: 38 })
  const frame = () => setup.captureCharFrame()
  const until = async (pred: (f: string) => boolean, what: string, timeoutMs = 20000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      await setup.renderOnce()
      const f = frame()
      if (pred(f)) return f
      await sleep(60)
    }
    throw new Error(`timed out waiting for: ${what}\n`)
  }
  const type = async (t: string) => {
    await setup.mockInput.typeText(t)
    await setup.renderOnce()
  }
  const enter = async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  }
  const say = async (t: string) => {
    await until((f) => f.includes("● ready"), "idle before typing")
    await type(t)
    await enter()
  }
  const ok = (m: string) => console.log("  ✓", m)
  const show = (title: string) => verbose && console.log(`--- ${title}\n${frame()}`)
  return { client, setup, frame, until, type, enter, say, ok, show }
}

await session("first run: chat, todos, subagent, approvals, errors, stop, tools, prompt", async (h) => {
  await h.until((f) => f.includes("New conversation"), "ready screen")
  h.ok("agent started and screen is ready")

  await h.say("plan something")
  await h.until((f) => f.includes("Draft the solution") && f.includes("I made a plan"), "todos + reply")
  h.show("after plan")
  h.ok("streamed reply + todos in sidebar")

  await h.say("research cats")
  await h.until((f) => f.includes("researcher") && f.includes("search_web") && f.includes("researcher reported"), "subagent run")
  h.ok("subagent output nested under its name")

  await h.say("please write a file")
  await h.until((f) => f.includes("Approval needed") && f.includes("write_file"), "approval prompt")
  h.show("approval")
  h.setup.mockInput.pressKey("y")
  await h.until((f) => f.includes("the file is written"), "approved write")
  h.ok("approval prompt shown and approved with 'y'")

  await h.say("boom now")
  await h.until((f) => f.includes("Simulated model failure") && f.includes("Ctrl+R continues"), "error banner")
  h.show("after error")
  h.ok("agent error shown, UI still alive")
  await h.say("hello after error")
  await h.until((f) => f.includes("You said: hello after error"), "works after error")
  h.ok("conversation continues after an error")

  await h.say("slow please")
  await h.until((f) => f.includes("word3"), "streaming started")
  h.setup.mockInput.pressEscape()
  await h.until((f) => f.includes("(stopped)") && f.includes("Stopped."), "stopped")
  h.ok("Esc stops a running turn")
  await h.say("typed after stop")
  await h.until((f) => f.includes("You said: typed after stop"), "new message after stop")
  h.ok("can send a new message right after stopping")

  await h.until((f) => f.includes("● ready"), "idle again")
  h.setup.mockInput.pressKey("r", { ctrl: true })
  await h.until((f) => (f.match(/You said: typed after stop/g) ?? []).length >= 2, "resend")
  h.ok("Ctrl+R resends the last message")

  h.setup.mockInput.pressKey("t", { ctrl: true })
  await h.until((f) => f.includes("Tools") && f.includes("general-purpose") && f.includes("researcher"), "tools panel")
  h.show("tools")
  h.ok("tools panel lists main + subagents")
  h.setup.mockInput.pressKey("ARROW_RIGHT")
  h.setup.mockInput.pressKey("ARROW_RIGHT")
  await h.until((f) => f.includes("Subagent: researcher"), "scope switch")
  h.setup.mockInput.pressKey("ARROW_DOWN")
  h.setup.mockInput.pressKey(" ")
  await h.until((f) => f.includes("[ ]"), "toggle off")
  h.ok("a subagent tool can be switched off")
  h.setup.mockInput.pressEscape()
  await h.until((f) => f.includes("message"), "back to chat")

  h.setup.mockInput.pressKey("g", { ctrl: true })
  await h.until((f) => f.includes("System prompt") && f.includes("demo agent for the deepagents TUI"), "prompt panel")
  h.ok("system prompt viewer shows the real prompt")
  h.setup.mockInput.pressEscape()
  await h.until((f) => f.includes("message"), "back to chat 2")
})

await session("reopen: last 5 messages restored in order", async (h) => {
  const f = await h.until((f) => f.includes("Restored the last 5 messages"), "history restored")
  h.show("reopened")
  const order = ["typed after stop", "You said: typed after stop"].map((s) => f.indexOf(s))
  if (order.some((i) => i < 0) || order[0]! > order[1]!) throw new Error("history order is wrong")
  h.ok("reopening shows the last 5 messages")
  if (!f.includes("earlier message")) throw new Error("expected a hidden-earlier-messages note")
  h.ok("tells you how many older messages are hidden")
  if (!f.includes("Draft the solution")) throw new Error("todos not restored")
  h.ok("todos restored")
  // toggle persisted from first session
  h.setup.mockInput.pressKey("t", { ctrl: true })
  await h.until((f) => f.includes("Tools"), "tools")
  h.setup.mockInput.pressKey("ARROW_RIGHT")
  h.setup.mockInput.pressKey("ARROW_RIGHT")
  await h.until((f) => f.includes("Subagent: researcher"), "scope")
  const tf = h.frame()
  if (!tf.includes("[ ]")) throw new Error("disabled tool was not remembered")
  h.ok("disabled tool remembered after restart")
  h.setup.mockInput.pressEscape()
})

await session("crash: killing the agent process must not kill the UI", async (h) => {
  await h.until((f) => f.includes("Restored the last"), "ready")
  // @ts-expect-error reach into the private child for the test
  h.client.child.kill("SIGKILL")
  await h.until((f) => f.includes("Agent process exited"), "crash noticed")
  h.show("crashed")
  h.ok("crash reported in the UI")
  await h.until((f) => f.includes("restarted") && f.includes("Restored the last"), "auto-restart + history", 30000)
  h.show("recovered")
  h.ok("agent restarted automatically and the conversation came back")
  await h.say("still here?")
  await h.until((f) => f.includes("You said: still here?"), "works after crash")
  h.ok("chat works after the crash")
})

console.log(failures ? `\n${failures} session(s) FAILED` : "\nAll TUI checks passed")
process.exit(failures ? 1 : 0)
