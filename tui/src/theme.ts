export const C = {
  bg: "#0f111a",
  panel: "#151826",
  line: "#2a2f45",
  fg: "#d5d9e6",
  dim: "#7b8399",
  faint: "#4b526b",
  accent: "#7aa2f7",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  purple: "#bb9af7",
  cyan: "#7dcfff",
}

export const levelColor = (l: "info" | "warn" | "error") => (l === "error" ? C.red : l === "warn" ? C.yellow : C.dim)

export function clipText(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= n ? one : one.slice(0, Math.max(0, n - 1)) + "…"
}

export function argSummary(args: unknown, n = 70): string {
  if (args == null) return ""
  if (typeof args !== "object") return clipText(String(args), n)
  const parts: string[] = []
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const val = typeof v === "string" ? JSON.stringify(clipText(v, 28)) : clipText(JSON.stringify(v) ?? "", 28)
    parts.push(`${k}=${val}`)
  }
  return clipText(parts.join(" "), n)
}

export function prettyArgs(args: unknown, maxLines = 14): string {
  let s: string
  try {
    s = JSON.stringify(args, null, 2) ?? ""
  } catch {
    s = String(args)
  }
  const lines = s.split("\n")
  return lines.length <= maxLines ? s : lines.slice(0, maxLines).join("\n") + `\n… (${lines.length - maxLines} more lines)`
}

export function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "-"
}
