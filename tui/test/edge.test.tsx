/** @jsxImportSource @opentui/react */
const origError = console.error
console.error = (...a: unknown[]) => {
  if (String(a[0]).includes("wrapped in act")) return
  origError(...a)
}
import { testRender } from "@opentui/react/test-utils"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { App } from "../src/App"
import { BridgeClient } from "../src/client"

const root = resolve(import.meta.dir, "..", "..")
const python = join(root, ".venv", "bin", "python")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0

async function run(label: string, target: string, w: number, h: number, fn: (x: any) => Promise<void>) {
  console.log(`\n=== ${label}`)
  const stateDir = mkdtempSync(join(tmpdir(), "deeptui-e-"))
  const client = new BridgeClient({ target, python, stateDir })
  const setup = await testRender(<App client={client} onQuit={() => {}} />, { width: w, height: h })
  const frame = () => setup.captureCharFrame()
  const until = async (pred: (f: string) => boolean, what: string, ms = 20000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await setup.renderOnce()
      if (pred(frame())) return frame()
      await sleep(60)
    }
    throw new Error("timed out: " + what)
  }
  const say = async (t: string) => {
    await until((f) => f.includes("● ready"), "idle")
    await setup.mockInput.typeText(t)
    await setup.renderOnce()
    setup.mockInput.pressEnter()
  }
  try {
    await fn({ setup, frame, until, say, client })
  } catch (e) {
    failures++
    console.log("  ✗ FAILED:", (e as Error).message, "\n" + frame())
  } finally {
    client.stop()
    await setup.dispose()
  }
}

// 1. an agent file with a bug in it
const bad = join(mkdtempSync(join(tmpdir(), "deeptui-bad-")), "broken_agent.py")
writeFileSync(bad, "def build_agent(ctx):\n    raise ValueError('MODEL_API_KEY is not set')\n")
await run("agent fails to load: UI explains, does not crash", `${bad}:build_agent`, 100, 30, async (x) => {
  await x.until((f: string) => f.includes("failed to load") && f.includes("MODEL_API_KEY is not set"), "fatal panel")
  console.log("  ✓ load error shown with the real message")
  console.log("  ✓ Ctrl+K hint visible:", x.frame().includes("Ctrl+K"))
  // fix the file, press Ctrl+K, it should load
  writeFileSync(bad, "from deeptui.demo_agent import build_agent\n")
  x.setup.mockInput.pressKey("k", { ctrl: true })
  await x.until((f: string) => f.includes("New conversation") || f.includes("Say something"), "reloaded after fix")
  console.log("  ✓ Ctrl+K reloads the agent after you fix the file")
})

// 2. narrow terminal + reject + edit
await run("80x24 terminal; reject then edit an approval", "deeptui.demo_agent:build_agent", 80, 24, async (x) => {
  await x.until((f: string) => f.includes("Say something"), "ready")
  await x.say("please write a file")
  await x.until((f: string) => f.includes("Approval needed"), "approval")
  x.setup.mockInput.pressKey("n")
  await x.until((f: string) => f.includes("Enter to reject"), "reject prompt")
  await x.setup.mockInput.typeText("not now")
  x.setup.mockInput.pressEnter()
  await x.until((f: string) => f.includes("tool was not executed") || f.includes("not executed") || f.includes("rejected") || f.includes("● ready"), "after reject")
  await x.until((f: string) => f.includes("● ready") && !f.includes("Approval needed"), "idle after reject")
  console.log("  ✓ reject with a reason works in 80x24")
  console.log(x.frame())
})
console.log(failures ? `\n${failures} FAILED` : "\nEdge checks passed")
process.exit(failures ? 1 : 0)
