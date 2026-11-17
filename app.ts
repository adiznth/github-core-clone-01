// The forge's HTTP server: routing, auth, JSON plumbing. One process, one
// in-memory store, no outside service, no git binary.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { gitPathParts, handleGit } from './git.ts';
import { handleRest, type Helpers } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === SHOP_TOKEN;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const helpers: Helpers = {
  sendJson,
  readBody,
  reqId: nextRequestId,
};

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP.
        const git = gitPathParts(path);
        if (git) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const url = new URL(req.url ?? '/', 'http://entry');
          await handleGit(req, res, store, git.owner, git.repo, git.rest, url.searchParams, () => readBody(req), (status, ct, body) =>
            sendRaw(res, status, ct, body),
          );
          return;
        }

        // MCP: auth is decided inside (a malformed body answers 400 first).
        if (path === '/mcp') {
          await handleMcp(req, res, store, helpers, authed(req));
          return;
        }

        // Everything else under /api needs the bearer token.
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }

        if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res, store, helpers)) return;
        }
        if (path === '/api/graphql') {
          if (await handleGraphQL(req, res, store, helpers)) return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // Response already gone.
        }
      }
    })();
  });
}
