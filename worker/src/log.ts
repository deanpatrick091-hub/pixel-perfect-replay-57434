import { config } from "./config.ts";

const secrets = () => [config.pumpPortalKey, config.ingestSecret].filter((s): s is string => !!s && s.length > 4);
function redact(s: string) {
  for (const sec of secrets()) s = s.split(sec).join("[redacted]");
  return s;
}
export const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(redact(line));
};
