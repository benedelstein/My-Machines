export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: LogValue }
  | LogValue[];

export type LogFields = Record<string, LogValue>;

export interface LogEntry {
  level: LogLevel;
  message: string;
  loggerName?: string;
  timestamp?: string;
  fields?: LogFields;
  error?: unknown;
}

export interface LogParams {
  fields?: LogFields;
  error?: unknown;
}

export interface Logger {
  log(message: string, params?: LogParams): void;
  debug(message: string, params?: LogParams): void;
  info(message: string, params?: LogParams): void;
  warn(message: string, params?: LogParams): void;
  error(message: string, params?: LogParams): void;
  scope(loggerName: string): Logger;
}

export interface ConsoleLoggerOptions {
  includeTimestamp?: boolean;
  now?: () => Date;
  format?: "pretty" | "json";
  minimumLevel?: LogLevel;
}

function numericLogLevel(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warn":
      return 2;
    case "error":
      return 3;
  }
}

export class ConsoleLogger implements Logger {
  private readonly options: ConsoleLoggerOptions;
  private readonly loggerName?: string;
  private readonly includeTimestamp: boolean;
  private readonly now: () => Date;
  private readonly format: "pretty" | "json";
  private readonly minimumLevel?: LogLevel;

  public constructor(options?: ConsoleLoggerOptions, loggerName?: string) {
    this.options = options ?? {};
    this.loggerName = loggerName;
    this.includeTimestamp = options?.includeTimestamp ?? true;
    this.now = options?.now ?? (() => new Date());
    this.format = options?.format ?? "pretty";
    this.minimumLevel = options?.minimumLevel;
  }

  public log(message: string, params?: LogParams): void {
    this.write("info", message, params);
  }

  public debug(message: string, params?: LogParams): void {
    this.write("debug", message, params);
  }

  public info(message: string, params?: LogParams): void {
    this.write("info", message, params);
  }

  public warn(message: string, params?: LogParams): void {
    this.write("warn", message, params);
  }

  public error(message: string, params?: LogParams): void {
    this.write("error", message, params);
  }

  public scope(loggerName: string): Logger {
    return new ConsoleLogger(this.options, loggerName);
  }

  private write(level: LogLevel, message: string, params?: LogParams): void {
    if (this.minimumLevel && numericLogLevel(level) < numericLogLevel(this.minimumLevel)) {
      return;
    }
    const entry = this.buildEntry(level, message, params);
    const serializedEntry = this.buildSerializedEntry(entry);
    const line =
      this.format === "json"
        ? this.serializeAsJson(serializedEntry)
        : this.serializeAsPretty(serializedEntry);
    this.writeLine(level, line);
  }

  private buildEntry(level: LogLevel, message: string, params?: LogParams): LogEntry {
    return {
      level,
      message,
      ...params,
      loggerName: this.loggerName,
    };
  }

  private buildSerializedEntry(entry: LogEntry): LogEntry {
    if (entry.timestamp || !this.includeTimestamp) {
      return entry;
    }

    return {
      ...entry,
      timestamp: this.now().toISOString(),
    };
  }

  private writeLine(level: LogLevel, line: string): void {
    switch (level) {
      case "debug":
        console.debug(line);
        return;
      case "info":
        console.info(line);
        return;
      case "warn":
        console.warn(line);
        return;
      case "error":
        console.error(line);
        return;
      default:
        console.log(line);
    }
  }

  private serializeAsJson(entry: LogEntry): string {
    return JSON.stringify(entry, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      return value;
    });
  }

  private serializeAsPretty(entry: LogEntry): string {
    const prefixParts = [`[${entry.level.toUpperCase()}]`];

    if (entry.timestamp) {
      prefixParts.push(`[${entry.timestamp}]`);
    }

    if (entry.loggerName) {
      prefixParts.push(`[${entry.loggerName}]`);
    }

    let line = `${prefixParts.join(" ")} ${entry.message}`;

    if (entry.fields && Object.keys(entry.fields).length > 0) {
      line += ` ${JSON.stringify(entry.fields)}`;
    }

    if (entry.error !== undefined) {
      line += ` error=${this.stringifyUnknown(entry.error)}`;
    }

    return line;
  }

  private stringifyUnknown(value: unknown): string {
    if (value instanceof Error) {
      return JSON.stringify({
        name: value.name,
        message: value.message,
        stack: value.stack,
      });
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

export class ComposedLogger implements Logger {
  private readonly loggers: readonly Logger[];
  private readonly minimumLevel?: LogLevel;

  public constructor(loggers: readonly Logger[], minimumLevel?: LogLevel) {
    this.loggers = loggers;
    this.minimumLevel = minimumLevel;
  }

  public log(message: string, params?: LogParams): void {
    this.dispatch("info", message, params);
  }

  public debug(message: string, params?: LogParams): void {
    this.dispatch("debug", message, params);
  }

  public info(message: string, params?: LogParams): void {
    this.dispatch("info", message, params);
  }

  public warn(message: string, params?: LogParams): void {
    this.dispatch("warn", message, params);
  }

  public error(message: string, params?: LogParams): void {
    this.dispatch("error", message, params);
  }

  public scope(loggerName: string): Logger {
    return new ComposedLogger(
      this.loggers.map((logger) => logger.scope(loggerName)),
      this.minimumLevel,
    );
  }

  private dispatch(level: LogLevel, message: string, params?: LogParams): void {
    if (this.minimumLevel && numericLogLevel(level) < numericLogLevel(this.minimumLevel)) {
      return;
    }

    const loggingErrors: unknown[] = [];

    for (const logger of this.loggers) {
      try {
        logger[level](message, params);
      } catch (error) {
        loggingErrors.push(error);
      }
    }

    if (loggingErrors.length === 0) {
      return;
    }

    if (loggingErrors.length === 1) {
      throw loggingErrors[0];
    }

    throw new AggregateError(
      loggingErrors,
      "ComposedLogger encountered multiple logger failures",
    );
  }
}

// Default logger used before initializeLogger() is called.
// Safe at module scope since it doesn't depend on env.
let rootLogger: Logger = new ComposedLogger(
  [new ConsoleLogger({ format: "pretty" })],
  "info",
);

/**
 * Reconfigure the root logger with environment-specific settings.
 * Call this early in the request lifecycle (e.g. Hono middleware).
 */
export function initializeLogger(options?: { level?: LogLevel; format?: "pretty" | "json" }): void {
  rootLogger = new ComposedLogger(
    [new ConsoleLogger({ format: options?.format ?? "pretty" })],
    options?.level ?? "info",
  );
}

/**
 * Returns a named logger that lazily delegates to the current rootLogger,
 * so it picks up any reconfiguration from initializeLogger(). The scoped
 * logger is cached and only re-created when the root changes.
 *
 * @param loggerName Scope shown on every line. Use the source file name.
 */
export function createLogger(loggerName: string): Logger {
  let cachedRootRef: Logger = rootLogger;
  let scopedLogger: Logger = rootLogger.scope(loggerName);

  const get = (): Logger => {
    if (rootLogger !== cachedRootRef) {
      cachedRootRef = rootLogger;
      scopedLogger = rootLogger.scope(loggerName);
    }
    return scopedLogger;
  };

  return {
    log: (message: string, params?: LogParams) => get().log(message, params),
    debug: (message: string, params?: LogParams) => get().debug(message, params),
    info: (message: string, params?: LogParams) => get().info(message, params),
    warn: (message: string, params?: LogParams) => get().warn(message, params),
    error: (message: string, params?: LogParams) => get().error(message, params),
    scope: (name: string) => createLogger(name),
  };
}
