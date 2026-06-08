/**
 * Minimal structured logger. Every line is JSON so that in production it can be
 * shipped to a log pipeline and queried by `agent_id`, `event`, `trust`, etc.
 * Observability is a first-class requirement of this system (see ARCHITECTURE.md),
 * and structured events are the cheapest, most durable form of it.
 */
type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit('info', event, fields),
  warn: (event: string, fields?: Fields) => emit('warn', event, fields),
  error: (event: string, fields?: Fields) => emit('error', event, fields),
};
