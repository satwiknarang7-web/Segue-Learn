import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLanAddress } from './lib/network.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  migrationsDir: path.join(rootDir, 'supabase', 'migrations'),
  dataDir: process.env.EDUPLATFORM_DATA_DIR
    ? path.resolve(process.env.EDUPLATFORM_DATA_DIR)
    : path.join(rootDir, 'data'),

  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 4000),

  /**
   * Where the database lives.
   *
   * With DATABASE_URL set, that Postgres is used -- in practice the Supabase
   * connection string. Without it, the app runs an embedded Postgres (PGlite)
   * under dataDir, so a fresh clone starts with nothing installed. Both are
   * real Postgres and run the same migrations; only the connection differs.
   */
  database: {
    url: process.env.DATABASE_URL ?? '',
    get embedded() {
      return !this.url;
    },
    /**
     * Where the embedded Postgres keeps its files. Ignored when url is set.
     * Null means keep the whole cluster in memory, which is what the tests do
     * so that each run starts from an empty database and leaves nothing behind.
     */
    embeddedPath:
      process.env.EDUPLATFORM_DB_MEMORY === 'true'
        ? null
        : path.join(
            process.env.EDUPLATFORM_DATA_DIR
              ? path.resolve(process.env.EDUPLATFORM_DATA_DIR)
              : path.join(rootDir, 'data'),
            'pgdata',
          ),
  },

  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '') ||
    ''
  ).replace(/\/+$/, ''),

  /** Allowance for network latency when deciding whether a submission was late. */
  submitGraceMs: 3_000,

  maxRequestBodyBytes: 256 * 1024,

  limits: {
    nameMaxLength: 80,
    emailMaxLength: 160,
    titleMaxLength: 120,
    descriptionMaxLength: 500,
    bodyMaxLength: 20_000,
    questionMaxLength: 500,
    optionMaxLength: 200,
    minOptions: 2,
    maxOptions: 6,
    maxAcceptedAnswers: 12,
    shortAnswerMaxLength: 200,
    imageMaxBytes: 3 * 1024 * 1024,
    imageAltMaxLength: 200,
    minTimeLimitSeconds: 10,
    maxTimeLimitSeconds: 4 * 60 * 60,
    minPoints: 1,
    maxPoints: 100,
    minPasswordLength: 10,
  },
};

export function resolveBaseUrl() {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const lanAddress = detectLanAddress();
  return `http://${lanAddress ?? 'localhost'}:${config.port}`;
}

/** Live quiz runs still hand out a code and a QR; this is what it encodes. */
export function buildJoinUrl(joinCode) {
  return `${resolveBaseUrl()}/join/${joinCode}`;
}

/**
 * Whether people reach this app over TLS. When they do, the session cookie is
 * marked Secure; when they do not -- a LAN address over plain HTTP -- marking
 * it Secure would stop the browser storing it at all.
 */
export function usesHttps() {
  if (process.env.EDUPLATFORM_SECURE_COOKIES === 'true') return true;
  if (process.env.EDUPLATFORM_SECURE_COOKIES === 'false') return false;
  return resolveBaseUrl().startsWith('https://');
}

export function isHostedDeployment() {
  return Boolean(
    process.env.RENDER || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME,
  );
}
