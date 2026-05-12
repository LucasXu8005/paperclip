import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseDeepSeekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  if (type === "deepseek.init") {
    return [{ kind: "init", ts, model: asString(parsed.model, "deepseek"), sessionId: "" }];
  }
  if (type === "deepseek.thinking") {
    const text = asString(parsed.text);
    return text ? [{ kind: "thinking", ts, text }] : [];
  }
  if (type === "deepseek.assistant") {
    const text = asString(parsed.text);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }
  if (type === "deepseek.result") {
    const usage = asRecord(parsed.usage) ?? {};
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.result),
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cachedTokens: asNumber(usage.cached_input_tokens),
        costUsd: 0,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ];
  }
  if (type === "deepseek.error") {
    return [{ kind: "stderr", ts, text: asString(parsed.error, "DeepSeek error") }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
