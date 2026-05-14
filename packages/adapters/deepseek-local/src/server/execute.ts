import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_LOCAL_MODEL } from "../index.js";

type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface DeepSeekChoice {
  finish_reason?: unknown;
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
    tool_calls?: unknown;
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

function resolveStringEnv(env: unknown): Record<string, string> {
  const record = parseObject(env);
  const resolved: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      resolved[key] = entry;
      continue;
    }
    const binding = parseObject(entry);
    if (binding.type === "plain" && typeof binding.value === "string") {
      resolved[key] = binding.value;
    }
  }
  return resolved;
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

function mergeUsage(current: UsageSummary | undefined, next: UsageSummary | undefined): UsageSummary | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
  };
}

function capText(value: string, maxChars = 64_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[paperclip: output truncated at ${maxChars} chars]`;
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const entry of value) {
    const record = parseObject(entry);
    const fn = parseObject(record.function);
    const id = asString(record.id, "").trim();
    const name = asString(fn.name, "").trim();
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    if (!id || !name) continue;
    calls.push({
      id,
      type: "function",
      function: {
        name,
        arguments: args,
      },
    });
  }
  return calls;
}

function parseJsonArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parseObject(parsed);
  } catch {
    return {};
  }
}

function resolveWorkspaceCwd(ctx: AdapterExecutionContext): string {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "").trim();
  const configuredCwd = asString(ctx.config.cwd, "").trim();
  return path.resolve(workspaceCwd || configuredCwd || process.cwd());
}

function resolveInsideCwd(cwd: string, candidate: unknown): string {
  const raw = asString(candidate, "").trim();
  const resolved = path.resolve(cwd, raw || ".");
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes working directory: ${raw}`);
  }
  return resolved;
}

function buildToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file from the current workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a UTF-8 text file in the current workspace, creating parent directories.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full file contents to write." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List entries in a workspace directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory path. Use . for root." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search text in the workspace with ripgrep.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Ripgrep search pattern." },
            path: { type: "string", description: "Optional workspace-relative path to search." },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command in the workspace. Use for tests, scripts, git status, and project commands.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
            timeoutSec: { type: "number", description: "Optional timeout in seconds, max 300." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paperclip_api",
        description: "Call the Paperclip REST API as this agent. Path may start with /api or an API-relative path.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "HTTP method, e.g. GET, POST, PATCH." },
            path: { type: "string", description: "API path such as /api/issues/{id}." },
            body: { type: "object", description: "Optional JSON body." },
          },
          required: ["method", "path"],
        },
      },
    },
  ];
}

async function runTool(input: {
  ctx: AdapterExecutionContext;
  cwd: string;
  env: Record<string, string>;
  call: ToolCall;
}): Promise<string> {
  const { ctx, cwd, env, call } = input;
  const args = parseJsonArgs(call.function.arguments);
  const name = call.function.name;
  await ctx.onLog(
    "stdout",
    eventLine({
      type: "deepseek.tool_call",
      id: call.id,
      name,
      input: args,
    }),
  );

  try {
    if (name === "read_file") {
      const filePath = resolveInsideCwd(cwd, args.path);
      const content = await fs.readFile(filePath, "utf8");
      return capText(content);
    }

    if (name === "write_file") {
      const filePath = resolveInsideCwd(cwd, args.path);
      const content = asString(args.content, "");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return `Wrote ${content.length} chars to ${path.relative(cwd, filePath)}`;
    }

    if (name === "list_dir") {
      const dirPath = resolveInsideCwd(cwd, args.path);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${entry.name}`)
        .sort()
        .join("\n");
    }

    if (name === "grep") {
      const pattern = asString(args.pattern, "").trim();
      if (!pattern) throw new Error("pattern is required");
      const searchPath = args.path ? path.relative(cwd, resolveInsideCwd(cwd, args.path)) : ".";
      const proc = await runChildProcess(ctx.runId, "rg", ["--line-number", "--no-heading", pattern, searchPath], {
        cwd,
        env,
        timeoutSec: 30,
        graceSec: 5,
        onLog: async () => {},
      });
      if ((proc.exitCode ?? 0) !== 0 && !proc.stdout.trim()) {
        return proc.stderr.trim() || "No matches.";
      }
      return capText(proc.stdout || proc.stderr);
    }

    if (name === "bash") {
      const command = asString(args.command, "").trim();
      if (!command) throw new Error("command is required");
      const requestedTimeout = asNumber(args.timeoutSec, 60);
      const timeoutSec = Math.max(1, Math.min(300, requestedTimeout));
      const proc = await runChildProcess(ctx.runId, "/bin/sh", ["-lc", command], {
        cwd,
        env,
        timeoutSec,
        graceSec: 5,
        onSpawn: ctx.onSpawn,
        onLog: async () => {},
      });
      return capText(
        [
          `exitCode: ${proc.exitCode ?? "null"}`,
          `signal: ${proc.signal ?? "null"}`,
          `timedOut: ${proc.timedOut ? "true" : "false"}`,
          proc.stdout ? `stdout:\n${proc.stdout}` : "",
          proc.stderr ? `stderr:\n${proc.stderr}` : "",
        ].filter(Boolean).join("\n\n"),
      );
    }

    if (name === "paperclip_api") {
      const method = asString(args.method, "GET").trim().toUpperCase();
      const rawPath = asString(args.path, "").trim();
      if (!rawPath) throw new Error("path is required");
      const apiBase = (env.PAPERCLIP_API_URL || "http://localhost:3100").replace(/\/+$/, "");
      const normalizedPath = rawPath.startsWith("/api/")
        ? rawPath
        : rawPath.startsWith("/")
          ? `/api${rawPath}`
          : `/api/${rawPath}`;
      const res = await fetch(`${apiBase}${normalizedPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(env.PAPERCLIP_API_KEY ? { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}` } : {}),
          ...(env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID } : {}),
        },
        body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(args.body ?? {}),
      });
      const text = await res.text();
      return capText(`HTTP ${res.status}\n${text}`);
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog(
      "stdout",
      eventLine({
        type: "deepseek.tool_result",
        id: call.id,
        name,
        isError: true,
        content: message,
      }),
    );
    return `ERROR: ${message}`;
  }
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
  tools: ToolDefinition[];
  maxTokens: number | null;
  temperature: number | null;
  timeoutSec: number;
}): Promise<DeepSeekResponse> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
  };
  if (input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  if (input.maxTokens !== null) body.max_tokens = input.maxTokens;
  if (input.temperature !== null) body.temperature = input.temperature;

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (input.timeoutSec > 0) {
    timeout = setTimeout(() => controller.abort(), input.timeoutSec * 1000);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DeepSeek API request timed out after ${input.timeoutSec}s`);
    }
    throw err;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

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
  const { config, onLog, onMeta, authToken } = ctx;
  const apiKey =
    resolveEnvValue(config.env, "DEEPSEEK_API_KEY").trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    "";
  const model = asString(config.model, DEFAULT_DEEPSEEK_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, DEFAULT_DEEPSEEK_BASE_URL).trim();
  const maxTokens = asNumber(config.maxTokens, 0) > 0 ? asNumber(config.maxTokens, 0) : null;
  const temperature = asNumber(config.temperature, Number.NaN);
  const normalizedTemperature = Number.isFinite(temperature) ? temperature : null;
  const rawTimeout = asNumber(config.timeoutSec, 120);
  const timeoutSec = rawTimeout > 0 ? Math.max(1, Math.min(600, rawTimeout)) : 0;

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
  const cwd = resolveWorkspaceCwd(ctx);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configEnv = resolveStringEnv(config.env);
  const hasExplicitPaperclipApiKey =
    typeof configEnv.PAPERCLIP_API_KEY === "string" && configEnv.PAPERCLIP_API_KEY.trim().length > 0;
  const env = {
    ...configEnv,
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
    ...(!hasExplicitPaperclipApiKey && authToken ? { PAPERCLIP_API_KEY: authToken } : {}),
  };
  const prompt = buildPrompt(ctx);
  const messages: ChatMessage[] = [];
  messages.push({
    role: "system",
    content: joinPromptSections([
      instructions,
      [
        "You are a Paperclip local agent backed by DeepSeek.",
        `Your current working directory is ${cwd}.`,
        "You can and should use tools to inspect files, edit files, run verification commands, and update Paperclip through the API.",
        "Do not claim you read or changed something unless a tool result proves it.",
        "Before finishing, leave durable progress in Paperclip using the paperclip_api tool when the task requires issue/comment/status updates.",
      ].join("\n"),
    ]),
  });
  messages.push({ role: "user", content: prompt });
  const tools = buildToolDefinitions();
  const maxToolIterations = Math.max(1, Math.min(100, asNumber(config.maxToolIterations, 60)));

  await onMeta?.({
    adapterType: "deepseek_local",
    command: "deepseek.chat.completions",
    commandNotes: [`POST ${baseUrl.replace(/\/+$/, "")}/chat/completions`],
    cwd,
    prompt,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: instructions.length,
    },
  });

  try {
    let totalUsage: UsageSummary | undefined;
    let lastText = "";
    let lastThinking = "";
    let exhaustedWithPendingToolCalls = false;
    let toolIterationLimitReached = false;

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await callDeepSeek({
        baseUrl,
        apiKey,
        model,
        messages,
        tools,
        maxTokens,
        temperature: normalizedTemperature,
        timeoutSec,
      });
      totalUsage = mergeUsage(totalUsage, usageFromResponse(response.usage));
      const choices = Array.isArray(response.choices) ? response.choices : [];
      const firstChoice = choices[0] as DeepSeekChoice | undefined;
      const text = trimNullable(firstChoice?.message?.content) ?? "";
      const thinking = trimNullable(firstChoice?.message?.reasoning_content) ?? "";
      const toolCalls = parseToolCalls(firstChoice?.message?.tool_calls);

      if (thinking) {
        lastThinking = thinking;
        await onLog("stdout", eventLine({ type: "deepseek.thinking", text: thinking }));
      }
      if (text) {
        lastText = text;
        await onLog("stdout", eventLine({ type: "deepseek.assistant", text }));
      }

      if (toolCalls.length === 0) break;
      if (iteration === maxToolIterations - 1) {
        exhaustedWithPendingToolCalls = true;
        toolIterationLimitReached = true;
      }

      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const result = await runTool({ ctx, cwd, env, call });
        await onLog(
          "stdout",
          eventLine({
            type: "deepseek.tool_result",
            id: call.id,
            name: call.function.name,
            isError: result.startsWith("ERROR:"),
            content: capText(result, 8_000),
          }),
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: capText(result),
        });
      }
    }

    if (exhaustedWithPendingToolCalls) {
      const warning = `DeepSeek reached maxToolIterations (${maxToolIterations}); requesting a final no-tool status response.`;
      await onLog("stderr", eventLine({ type: "deepseek.warning", warning }));
      messages.push({
        role: "user",
        content: [
          warning,
          "Do not request more tools.",
          "Based only on the completed tool results above, provide a concise final report.",
          "State whether the issue is done, blocked, or still in progress.",
          "If a required Paperclip API update or file change was not completed, say so explicitly.",
        ].join("\n"),
      });
      const finalResponse = await callDeepSeek({
        baseUrl,
        apiKey,
        model,
        messages,
        tools: [],
        maxTokens,
        temperature: normalizedTemperature,
        timeoutSec,
      });
      totalUsage = mergeUsage(totalUsage, usageFromResponse(finalResponse.usage));
      const choices = Array.isArray(finalResponse.choices) ? finalResponse.choices : [];
      const firstChoice = choices[0] as DeepSeekChoice | undefined;
      const text = trimNullable(firstChoice?.message?.content) ?? "";
      const thinking = trimNullable(firstChoice?.message?.reasoning_content) ?? "";
      if (!text && !thinking) {
        throw new Error("DeepSeek completed without final text after tool iteration limit.");
      }
      if (thinking) {
        lastThinking = thinking;
        await onLog("stdout", eventLine({ type: "deepseek.thinking", text: thinking }));
      }
      if (text) {
        lastText = text;
        await onLog("stdout", eventLine({ type: "deepseek.assistant", text }));
      }
    }

    const summary = firstNonEmptyLine(lastText);

    if (!lastText && !lastThinking) {
      throw new Error("DeepSeek completed without assistant text after tool loop.");
    }
    await onLog(
      "stdout",
      eventLine({
        type: "deepseek.result",
        result: summary,
        usage: {
          input_tokens: totalUsage?.inputTokens ?? 0,
          output_tokens: totalUsage?.outputTokens ?? 0,
          cached_input_tokens: totalUsage?.cachedInputTokens ?? 0,
        },
      }),
    );

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: totalUsage,
      provider: "deepseek",
      biller: "deepseek",
      model,
      billingType: "api",
      resultJson: {
        toolIterations: messages.filter((message) => message.role === "tool").length,
        toolIterationLimitReached,
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
