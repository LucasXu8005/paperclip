import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_LOCAL_MODEL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function resolveEnvValue(env: unknown, key: string): string {
  const record = parseObject(env);
  const entry = record[key];
  if (typeof entry === "string") return entry;
  const binding = parseObject(entry);
  if (binding.type === "plain" && typeof binding.value === "string") return binding.value;
  return "";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const apiKey =
    resolveEnvValue(config.env, "DEEPSEEK_API_KEY").trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    "";
  const model = asString(config.model, DEFAULT_DEEPSEEK_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, DEFAULT_DEEPSEEK_BASE_URL).trim();

  if (!apiKey) {
    checks.push({
      code: "deepseek_api_key_missing",
      level: "error",
      message: "DEEPSEEK_API_KEY is required.",
      hint: "Add DEEPSEEK_API_KEY to the adapter environment, or set it in the Paperclip server environment.",
    });
  } else {
    checks.push({
      code: "deepseek_api_key_present",
      level: "info",
      message: "DeepSeek API key is configured.",
    });
  }

  try {
    new URL(baseUrl);
    checks.push({
      code: "deepseek_base_url_valid",
      level: "info",
      message: `Base URL is valid: ${baseUrl}`,
    });
  } catch {
    checks.push({
      code: "deepseek_base_url_invalid",
      level: "error",
      message: "DeepSeek baseUrl must be a valid URL.",
      detail: baseUrl,
    });
  }

  if (apiKey && checks.every((check) => check.code !== "deepseek_base_url_invalid")) {
    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/models`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!res.ok) {
        checks.push({
          code: "deepseek_auth_probe_failed",
          level: "error",
          message: `DeepSeek model probe failed with HTTP ${res.status}.`,
        });
      } else {
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = Array.isArray(body.data)
          ? body.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string")
          : [];
        checks.push({
          code: ids.includes(model) ? "deepseek_model_available" : "deepseek_model_unknown",
          level: ids.length === 0 || ids.includes(model) ? "info" : "warn",
          message:
            ids.length === 0
              ? "DeepSeek API key is valid; model list did not include model ids."
              : ids.includes(model)
                ? `Model "${model}" is available.`
                : `Model "${model}" was not found in the DeepSeek model list.`,
        });
      }
    } catch (err) {
      checks.push({
        code: "deepseek_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Failed to probe DeepSeek API.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
