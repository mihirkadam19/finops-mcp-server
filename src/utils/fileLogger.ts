import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(
  os.homedir(),
  "mcp-server-logs",
);

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(scope: string): string {
  const date = new Date().toISOString().split("T")[0]!;
  return path.join(LOG_DIR, `${scope}-${date}.log`);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error as Error & { code?: string; $metadata?: unknown }).code !== undefined && {
        code: (error as Error & { code?: string }).code,
      },
      ...("$metadata" in error && { metadata: (error as { $metadata?: unknown }).$metadata }),
    };
  }
  return { message: String(error) };
}

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>) => Logger;
}

export function createLogger(scope: string, baseContext: Record<string, unknown> = {}): Logger {
  ensureLogDir();
  const logFile = getLogFilePath(scope);

  const write = (level: string, message: string, data?: Record<string, unknown>) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...baseContext,
      ...data,
    };
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logFile, line, "utf8");
    const contextSuffix = Object.keys(baseContext).length > 0 ? ` ${JSON.stringify(baseContext)}` : "";
    const dataSuffix = data ? ` ${JSON.stringify(data)}` : "";
    console.error(`[${scope}] [${level}] ${message}${contextSuffix}${dataSuffix}`);
  };

  const logger: Logger = {
    debug: (message, data) => write("DEBUG", message, data),
    info: (message, data) => write("INFO", message, data),
    warn: (message, data) => write("WARN", message, data),
    error: (message, data) => write("ERROR", message, data),
    child: (context) => createLogger(scope, { ...baseContext, ...context }),
  };

  return logger;
}

export function getAwsCredentialContext(): Record<string, unknown> {
  return {
    aws_access_key_id: process.env.AWS_ACCESS_KEY_ID ? "set" : "missing",
    aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY ? "set" : "missing",
    aws_session_token: process.env.AWS_SESSION_TOKEN ? "set" : "missing",
    aws_profile: process.env.AWS_PROFILE ?? "(default)",
    aws_region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "(not set)",
    aws_shared_credentials_file: process.env.AWS_SHARED_CREDENTIALS_FILE ?? "(default ~/.aws/credentials)",
    aws_config_file: process.env.AWS_CONFIG_FILE ?? "(default ~/.aws/config)",
    node_env: process.env.NODE_ENV ?? "(not set)",
    cwd: process.cwd(),
  };
}

export { serializeError, LOG_DIR };
