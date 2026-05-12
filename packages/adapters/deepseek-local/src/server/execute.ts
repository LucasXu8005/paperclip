import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_LOCAL_MODEL } from "../index.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface DeepSeekChoice {
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
}

interface DeepSeekResponse {
  id?: unknown;
  choices?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
  };
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

function resolveEnvValue(env: unknown, key: string): string {
  const record = parseObject(env);
  const entry = record[key];
  if (typeof entry === "string") return entry;
  const binding = parseObject(entry);
  if (binding.type === "plain" && typeof binding.value === "string") return binding.value;
  return "";
}

function eventLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function usageFromResponse(value: DeepSeekResponse["usage"]): UsageSummary | undefined {
  if (!value) return undefined;
  const inputTokens = asNumber(value.prompt_tokens, 0);
  const outputTokens = asNumber(value.completion_tokens, 0);
  const cachedInputTokens = asNumber(value.prompt_cache_hit_tokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

async function readInstructions(path: string, onLog: AdapterExecutionContext["onLog"]): Promise<string> {
  if (!path) return "";
  try {
    const contents = await fs.readFile(path, "utf8");
    return contents.trim();
  } catch (err) {
    await onLog(
      "stderr",
      eventLine({
        type: "deepseek.error",
        error: `Could not read instructionsFilePath "${path}": ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return "";
  }
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const promptTemplate = asString(ctx.config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  return joinPromptSections([
    renderTemplate(promptTemplate, {
      agent: ctx.agent,
      context: ctx.context,
      runtime: ctx.runtime,
    }),
    wakePrompt,
  ]);
}

async function callDeepSeek(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number | null;
  temperature: number | null;
}): Promise<DeepSeekResponse> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
  };
  if (input.maxTokens !== null) body.max_tokens = input.maxTokens;
  if (input.temperature !== null) body.temperature = input.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: DeepSeekResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as DeepSeekResponse) : {};
  } catch {
    parsed = { error: { message: text || `HTTP ${res.status}` } };
  }

  if (!res.ok) {
    const message = trimNullable(parsed.error?.message) ?? `DeepSeek API request failed with HTTP ${res.status}`;
    throw new Error(message);
  }

  return parsed;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, onLog, onMeta } = ctx;
  const apiKey =
    resolveEnvValue(config.env, "DEEPSEEK_API_KEY").trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    "";
  const model = asString(config.model, DEFAULT_DEEPSEEK_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, DEFAULT_DEEPSEEK_BASE_URL).trim();
  const maxTokens = asNumber(config.maxTokens, 0) > 0 ? asNumber(config.maxTokens, 0) : null;
  const temperature = asNumber(config.temperature, Number.NaN);
  const normalizedTemperature = Number.isFinite(temperature) ? temperature : null;

  await onLog("stdout", eventLine({ type: "deepseek.init", model }));

  if (!apiKey) {
    const errorMessage = "DEEPSEEK_API_KEY is required for deepseek_local.";
    await onLog("stderr", eventLine({ type: "deepseek.error", error: errorMessage }));
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      provider: "deepseek",
      biller: "deepseek",
      model,
      billingType: "api",
    };
  }

  const instructions = await readInstructions(asString(config.instructionsFilePath, "").trim(), onLog);
  const prompt = buildPrompt(ctx);
  const messages: ChatMessage[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push({ role: "user", content: prompt });

  await onMeta?.({
    adapterType: "deepseek_local",
    command: "deepseek.chat.completions",
    commandNotes: [`POST ${baseUrl.replace(/\/+$/, "")}/chat/completions`],
    prompt,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: instructions.length,
    },
  });

  try {
    const response = await callDeepSeek({
      baseUrl,
      apiKey,
      model,
      messages,
      maxTokens,
      temperature: normalizedTemperature,
    });
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const firstChoice = choices[0] as DeepSeekChoice | undefined;
    const text = trimNullable(firstChoice?.message?.content) ?? "";
    const thinking = trimNullable(firstChoice?.message?.reasoning_content) ?? "";
    const usage = usageFromResponse(response.usage);
    const summary = firstNonEmptyLine(text);

    if (thinking) {
      await onLog("stdout", eventLine({ type: "deepseek.thinking", text: thinking }));
    }
    if (text) {
      await onLog("stdout", eventLine({ type: "deepseek.assistant", text }));
    }
    await onLog(
      "stdout",
      eventLine({
        type: "deepseek.result",
        result: summary,
        usage: {
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          cached_input_tokens: usage?.cachedInputTokens ?? 0,
        },
      }),
    );

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage,
      provider: "deepseek",
      biller: "deepseek",
      model,
      billingType: "api",
      resultJson: {
        id: trimNullable(response.id),
      },
      summary: summary || null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await onLog("stderr", eventLine({ type: "deepseek.error", error: errorMessage }));
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      provider: "deepseek",
      biller: "deepseek",
      model,
      billingType: "api",
    };
  }
}
