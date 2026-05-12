import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildDeepSeekLocalConfig,
  parseDeepSeekStdoutLine,
} from "@paperclipai/adapter-deepseek-local/ui";

export const deepSeekLocalUIAdapter: UIAdapterModule = {
  type: "deepseek_local",
  label: "DeepSeek",
  parseStdoutLine: parseDeepSeekStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildDeepSeekLocalConfig,
};
