import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

type LoggerOptions = {
  sink?: LogSink;
  secretValues?: readonly string[];
  fields?: LogFields;
  now?: () => Date;
};

const secretKey = /(?:authorization|credential|password|secret|token|api[_-]?key)/iu;
const secretPatterns = [
  /\bBearer\s+[^\s"']+/giu,
  /\bccb_[A-Za-z0-9._-]+\b/gu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
];

export function environmentSecretValues(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => secretKey.test(key) && Boolean(value))
    .map(([, value]) => value as string);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const secrets = (options.secretValues ?? []).filter((value) => value.length > 0);
  const baseFields = options.fields ?? {};
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const record = sanitize(
      {
        time: now().toISOString(),
        level,
        message,
        ...baseFields,
        ...fields,
      },
      secrets,
    );
    sink(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, sink, secretValues: secrets, now, fields: { ...baseFields, ...fields } }),
  };
}

function sanitize(value: unknown, secrets: readonly string[], key?: string, seen = new WeakSet<object>()): unknown {
  if (key && secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, secrets),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, undefined, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitize(childValue, secrets, childKey, seen);
    }
    return output;
  }
  return redactString(inspect(value), secrets);
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  for (const pattern of secretPatterns) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}
