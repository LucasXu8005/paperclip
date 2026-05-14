import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function makeContext(
  overrides: Partial<AdapterExecutionContext> = {},
): Promise<AdapterExecutionContext & { logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>; cwd: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-deepseek-test-"));
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "DeepSeek Agent",
      adapterType: "deepseek_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd,
      model: "deepseek-chat",
      env: {
        DEEPSEEK_API_KEY: { type: "plain", value: "deepseek-key" },
      },
      timeoutSec: 5,
      maxToolIterations: 5,
    },
    context: {},
    authToken: "agent-run-jwt",
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    ...overrides,
  };
  return { ...ctx, logs, cwd };
}

describe("deepseek_local execute", () => {
  const originalRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

  beforeEach(() => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.test";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalRuntimeApiUrl === undefined) {
      delete process.env.PAPERCLIP_RUNTIME_API_URL;
    } else {
      process.env.PAPERCLIP_RUNTIME_API_URL = originalRuntimeApiUrl;
    }
    vi.restoreAllMocks();
  });

  it("executes Paperclip API tool calls with the injected run JWT", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string }> };
        const hasToolResult = body.messages.some((message) => message.role === "tool");
        return jsonResponse({
          choices: [
            hasToolResult
              ? { message: { content: "Comment posted." } }
              : {
                  message: {
                    content: "I will update Paperclip.",
                    tool_calls: [
                      {
                        id: "tool-1",
                        type: "function",
                        function: {
                          name: "paperclip_api",
                          arguments: JSON.stringify({
                            method: "POST",
                            path: "/api/issues/issue-1/comments",
                            body: { body: "done" },
                          }),
                        },
                      },
                    ],
                  },
                },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }

      expect(href).toBe("http://paperclip.test/api/issues/issue-1/comments");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer agent-run-jwt");
      expect((init?.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe("run-1");
      expect(JSON.parse(String(init?.body))).toEqual({ body: "done" });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await makeContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Comment posted.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.logs.some((entry) => entry.chunk.includes('"type":"deepseek.tool_call"'))).toBe(true);
    expect(ctx.logs.some((entry) => entry.chunk.includes('"type":"deepseek.tool_result"'))).toBe(true);
  });

  it("preserves an explicit PAPERCLIP_API_KEY over the injected run JWT", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string }> };
        const hasToolResult = body.messages.some((message) => message.role === "tool");
        return jsonResponse({
          choices: [
            hasToolResult
              ? { message: { content: "Done." } }
              : {
                  message: {
                    tool_calls: [
                      {
                        id: "tool-1",
                        type: "function",
                        function: {
                          name: "paperclip_api",
                          arguments: JSON.stringify({ method: "GET", path: "/api/agents/me" }),
                        },
                      },
                    ],
                  },
                },
          ],
        });
      }

      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer explicit-key");
      return jsonResponse({ id: "agent-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await makeContext({
      config: {
        cwd: "",
        model: "deepseek-chat",
        env: {
          DEEPSEEK_API_KEY: { type: "plain", value: "deepseek-key" },
          PAPERCLIP_API_KEY: { type: "plain", value: "explicit-key" },
        },
        timeoutSec: 5,
      },
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
  });

  it("forces a final no-tool response when tool calls still remain at the iteration limit", async () => {
    const ctx = await makeContext({
      config: {
        model: "deepseek-chat",
        env: {
          DEEPSEEK_API_KEY: { type: "plain", value: "deepseek-key" },
        },
        maxToolIterations: 1,
      },
    });
    await fs.writeFile(path.join(ctx.cwd, "note.txt"), "hello", "utf8");

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/chat/completions");
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: unknown[] };
      if (body.tools) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: "Reading.",
                tool_calls: [
                  {
                    id: "tool-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "note.txt" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: "Reached the tool limit after reading note.txt; status is still in progress.",
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Reached the tool limit after reading note.txt; status is still in progress.");
    expect(result.resultJson).toMatchObject({
      toolIterations: 1,
      toolIterationLimitReached: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.logs.some((entry) => entry.chunk.includes('"type":"deepseek.warning"'))).toBe(true);
  });
});
