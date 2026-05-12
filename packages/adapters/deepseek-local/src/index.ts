import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "deepseek_local";
export const label = "DeepSeek";

export const DEFAULT_DEEPSEEK_LOCAL_MODEL = "deepseek-chat";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const models = [
  { id: DEFAULT_DEEPSEEK_LOCAL_MODEL, label: "DeepSeek Chat" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use DeepSeek Chat as the budget lane while preserving the primary model.",
    adapterConfig: {
      model: DEFAULT_DEEPSEEK_LOCAL_MODEL,
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# deepseek_local agent configuration

Adapter: deepseek_local

Use when:
- You want Paperclip to invoke DeepSeek through its OpenAI-compatible chat completions API
- You want a lightweight API-backed agent that returns a transcript and run summary
- You want deepseek-reasoner reasoning output shown as thinking transcript entries

Don't use when:
- You need local filesystem/tool execution (use claude_local, codex_local, gemini_local, opencode_local, pi_local, or cursor)
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot shell command (use process)

Core fields:
- model (string, optional): DeepSeek model id. Defaults to deepseek-chat.
- baseUrl (string, optional): OpenAI-compatible API base URL. Defaults to https://api.deepseek.com.
- instructionsFilePath (string, optional): absolute path to a markdown instructions file used as a system prompt prefix
- promptTemplate (string, optional): run prompt template
- maxTokens (number, optional): maximum output tokens
- temperature (number, optional): sampling temperature
- env.DEEPSEEK_API_KEY (string, optional): DeepSeek API key. Falls back to server process DEEPSEEK_API_KEY.

Notes:
- This adapter calls /chat/completions directly; it does not provide local tools or session resume.
- The model's final text is logged as assistant output and returned as the run summary.
`;
