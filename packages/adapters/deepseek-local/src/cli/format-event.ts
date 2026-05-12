import pc from "picocolors";
import { parseDeepSeekStdoutLine } from "../ui/parse-stdout.js";

export function printDeepSeekStreamEvent(raw: string, _debug: boolean): void {
  const entries = parseDeepSeekStdoutLine(raw, new Date().toISOString());
  for (const entry of entries) {
    switch (entry.kind) {
      case "assistant":
        console.log(pc.green(`assistant: ${entry.text}`));
        break;
      case "thinking":
        console.log(pc.gray(`thinking: ${entry.text}`));
        break;
      case "result":
        console.log(pc.blue(`result: ${entry.text || "completed"}`));
        break;
      case "stderr":
        console.error(pc.red(entry.text));
        break;
      case "init":
        console.log(pc.blue(`DeepSeek init (${entry.model})`));
        break;
      case "stdout":
        console.log(entry.text);
        break;
      default:
        if ("text" in entry) console.log(entry.text);
    }
  }
}
