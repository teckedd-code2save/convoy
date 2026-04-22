interface LogFields {
  level: 'info' | 'warn' | 'error';
  message: string;
  [key: string]: unknown;
}

/**
 * Emits structured JSON log lines to stdout. Convoy's medic reads
 * this stream verbatim to diagnose failures.
 */
export function log(fields: LogFields): void {
  const { level, message, ...rest } = fields;
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...rest,
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(record)}\n`);
}
