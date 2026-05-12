import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_DEEPSEEK_BASE_URL } from "../index.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: DEFAULT_DEEPSEEK_BASE_URL,
        hint: "OpenAI-compatible DeepSeek API base URL.",
      },
      {
        key: "maxTokens",
        label: "Max tokens",
        type: "number",
        hint: "Optional cap for output tokens.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "Optional sampling temperature.",
      },
    ],
  };
}
