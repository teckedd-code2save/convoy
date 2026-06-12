/**
 * Secret vs config classification for env keys (issue #34).
 *
 * Every key from .env.example used to render as a "Required secret" —
 * LOG_LEVEL and PORT got the same red treatment as DATABASE_URL. The split
 * matters operationally: secrets must be staged through the secrets path
 * (never echoed, pushed to the platform's secret store), while config is
 * plain environment a reviewer can read and often has a safe default
 * already sitting in the example file.
 *
 * Classification is deterministic and name-based. We don't read values:
 * a key shaped like a credential is treated as one even if the example
 * value is a placeholder.
 */

export type EnvKeyKind = 'secret' | 'config';

/** Name fragments that mark a key as a credential. */
const SECRET_NAME_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|DSN|_KEY$/i;

/**
 * Connection-string keys whose values conventionally embed credentials
 * (postgres://user:pass@..., redis://:pass@...). The key name alone is
 * enough — these are secrets even without SECRET/TOKEN in the name.
 */
const CREDENTIALED_URL_PATTERN =
  /^(DATABASE|POSTGRES(QL)?|PG|MYSQL|REDIS|MONGO(DB)?|AMQP|RABBITMQ|KAFKA|ELASTIC(SEARCH)?|CLICKHOUSE)_(URL|URI)$/i;

export function classifyEnvKey(key: string): EnvKeyKind {
  if (SECRET_NAME_PATTERN.test(key)) return 'secret';
  if (CREDENTIALED_URL_PATTERN.test(key)) return 'secret';
  if (/^MONGODB_URI$|^MONGO_URL$/i.test(key)) return 'secret';
  return 'config';
}
