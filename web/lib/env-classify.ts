/**
 * Secret vs config classification for env keys. Mirrors
 * src/core/env-classify.ts — the web app reads plan JSON from disk and
 * cannot import across the package boundary, so the (small, stable)
 * pattern set is duplicated here. Keep the two in sync.
 */

export type EnvKeyKind = 'secret' | 'config';

const SECRET_NAME_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|DSN|_KEY$/i;

const CREDENTIALED_URL_PATTERN =
  /^(DATABASE|POSTGRES(QL)?|PG|MYSQL|REDIS|MONGO(DB)?|AMQP|RABBITMQ|KAFKA|ELASTIC(SEARCH)?|CLICKHOUSE)_(URL|URI)$/i;

export function classifyEnvKey(key: string): EnvKeyKind {
  if (SECRET_NAME_PATTERN.test(key)) return 'secret';
  if (CREDENTIALED_URL_PATTERN.test(key)) return 'secret';
  if (/^MONGODB_URI$|^MONGO_URL$/i.test(key)) return 'secret';
  return 'config';
}
