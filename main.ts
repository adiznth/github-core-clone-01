// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// On top of that lifecycle this entrypoint also owns the process's startup checks and shutdown:
//
//   - Startup config: MAKEFUN_ENV_URL is parsed as a URL and must be http(s); the request timeout and
//     the retry backoff can be tuned with MAKEFUN_REQUEST_TIMEOUT_MS, MAKEFUN_RETRY_INITIAL_MS and
//     MAKEFUN_RETRY_MAX_MS, each validated and clamped to a sane range. A missing MAKEFUN_SHOP_TOKEN
//     is warned about up front, since every authenticated route would answer 401 without it.
//   - Graceful shutdown: SIGINT and SIGTERM abort the register/done polling (in-flight requests are
//     cancelled, the backoff sleep wakes at once), close the listening server, and exit 0. The
//     harness stops the entry this way after a trial, so a mid-run signal must not leave a hanging
//     process or a half-open port behind.
//
// main.ts imports its own server and nothing else: no package, no Node built-in beyond the process
// globals the runtime already provides, no model call.

import { createApp } from './app.ts';

/** Everything the lifecycle reads from the environment, resolved once at startup. */
interface EntryConfig {
  /** The env origin, trailing slashes stripped. */
  envUrl: string;
  /** How long one register or done request may take before it is abandoned and retried. */
  requestTimeoutMs: number;
  /** The first wait between retries. */
  retryInitialMs: number;
  /** The longest wait between retries. */
  retryMaxMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INITIAL_MS = 250;
const DEFAULT_RETRY_MAX_MS = 2_000;

/** The smallest and largest values the timeout overrides are allowed to take. */
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_LIMIT_MS = 30_000;

/**
 * Read an integer millisecond override from the environment. A missing variable keeps the default;
 * a present but unparsable or out-of-range value warns and is clamped into range, so a typo in
 * the environment can slow the entry down but never break the lifecycle.
 */
function readMsOverride(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(`[entry] warning: ${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}ms\n`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    process.stderr.write(`[entry] warning: ${name}=${parsed}ms is outside ${min}..${max}ms; clamping\n`);
    return Math.min(max, Math.max(min, parsed));
  }
  return parsed;
}

/**
 * Resolve and validate the startup config. Exits 1 when MAKEFUN_ENV_URL is missing or is not a
 * usable http(s) URL: with no env to talk to, registering would only fail in a retry loop.
 * Warns (but continues) when MAKEFUN_SHOP_TOKEN is unset, since the forge still boots and
 * answers the /healthz probe — only the authenticated routes reject.
 */
function readConfig(): EntryConfig {
  const rawEnvUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (rawEnvUrl === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  let origin: string;
  try {
    const parsed = new URL(rawEnvUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`protocol ${JSON.stringify(parsed.protocol)} is not http(s)`);
    }
    origin = parsed.origin;
  } catch (err) {
    process.stderr.write(
      `[entry] MAKEFUN_ENV_URL ${JSON.stringify(rawEnvUrl)} is not a usable env origin: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if ((process.env.MAKEFUN_SHOP_TOKEN ?? '') === '') {
    process.stderr.write('[entry] warning: MAKEFUN_SHOP_TOKEN is not set; authenticated routes will answer 401\n');
  }

  const requestTimeoutMs = readMsOverride('MAKEFUN_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
  const retryInitialMs = readMsOverride('MAKEFUN_RETRY_INITIAL_MS', DEFAULT_RETRY_INITIAL_MS, RETRY_MIN_MS, RETRY_MAX_LIMIT_MS);
  const retryMaxMs = readMsOverride('MAKEFUN_RETRY_MAX_MS', DEFAULT_RETRY_MAX_MS, RETRY_MIN_MS, RETRY_MAX_LIMIT_MS);
  // The backoff must actually back off: a max below the initial wait is raised to the initial wait.
  const config: EntryConfig = {
    envUrl: origin,
    requestTimeoutMs,
    retryInitialMs,
    retryMaxMs: Math.max(retryMaxMs, retryInitialMs),
  };
  process.stdout.write(
    `[entry] env ${config.envUrl}, request timeout ${config.requestTimeoutMs}ms, retry ${config.retryInitialMs}..${config.retryMaxMs}ms\n`,
  );
  return config;
}

/**
 * A sleep that wakes early when the shutdown signal fires, so a signal received mid-backoff does
 * not leave the process sitting out the rest of the wait.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait after `attempt` failed requests: exponential from the initial wait, capped at the max. */
function retryDelay(attempt: number, config: EntryConfig): number {
  return Math.min(config.retryMaxMs, config.retryInitialMs * 2 ** Math.min(attempt, 8));
}

/** One request timeout combined with the shutdown signal, so a signal cancels the request. */
function requestSignal(config: EntryConfig, shutdown: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), shutdown]);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 * Returns false when a shutdown signal arrived before the env accepted the registration.
 */
async function register(port: number, config: EntryConfig, shutdown: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (shutdown.aborted) return false;
    try {
      const res = await fetch(`${config.envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: requestSignal(config, shutdown),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (shutdown.aborted) return false;
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt, config), shutdown);
  }
}

/**
 * Poll GET /done until it answers {"done":true}; never return true before that.
 * Returns false when a shutdown signal arrived while the env still said not done.
 */
async function waitForDone(config: EntryConfig, shutdown: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (shutdown.aborted) return false;
    try {
      const res = await fetch(`${config.envUrl}/done`, { signal: requestSignal(config, shutdown) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return true;
      }
    } catch {
      if (shutdown.aborted) return false;
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt, config), shutdown);
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const config = readConfig();

  // The harness stops the entry with SIGTERM after a trial; Ctrl-C sends SIGINT. Either way the
  // polling below must stop promptly and the server must close instead of hanging on a retry.
  const shutdown = new AbortController();
  let signalName: string | null = null;
  const onSignal = (name: string): void => {
    if (signalName !== null) return;
    signalName = name;
    process.stderr.write(`[entry] ${name} received: shutting down\n`);
    shutdown.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  const registered = await register(address.port, config, shutdown.signal);
  if (!registered) {
    server.close();
    process.stdout.write('[entry] stopped before registering\n');
    return;
  }
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  const done = await waitForDone(config, shutdown.signal);
  server.close();
  process.stdout.write(done ? '[entry] done\n' : '[entry] stopped before done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
