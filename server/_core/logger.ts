// server/_core/logger.ts
//
// Single pino logger instance for the API. JSON output in production (parsed
// by Render's log aggregator and any downstream sink), pretty output in
// development for human readability.
//
// Migration policy: existing call sites that use `console.log/warn/error`
// continue to work. New code in server/ should prefer `logger`. A future PR
// can sweep the remaining console calls — out of scope for Frente 2.3.

import pino from "pino";

function resolveLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.trim();
  if (envLevel) return envLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const isPretty =
  process.env.NODE_ENV !== "production" && process.env.LOG_FORMAT !== "json";

export const logger = pino({
  level: resolveLevel(),
  base: { service: "escalas-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-test-user-id']",
      "*.password",
      "*.passwordHash",
      "*.systemPassword",
      "*.systemPin",
    ],
    censor: "[REDACTED]",
  },
  ...(isPretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service",
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
