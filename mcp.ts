// MCP (/mcp): JSON-RPC 2.0 over Streamable HTTP. Modern era 2026-07-28 via
// server/discover, with the legacy initialize handshake as fallback. The six
// canonical tools act on the same store as REST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, tickNow, type Repo, type Store } from './store.ts';
import { issueRestId, pullRestId, squashMerge } from './rest.ts';
import type { Helpers } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner || parts[0]!;
      repoName = repoName || parts[1]!;
    }
  }
  if (!owner || !repoName) return null;
  if (owner !== VIEWER.login) return null;
  return store.get(owner, repoName) ?? null;
}

function textResult(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function errorResult(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = (canonical: string): boolean => norm === canonical || norm.endsWith(canonical);
  if (match('createrepo')) {
    const repoName = typeof args.name === 'string' ? args.name : typeof args.repo === 'string' ? args.repo : '';
    if (!repoName) return errorResult('create_repo requires a name');
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER.login;
    if (owner !== VIEWER.login) return errorResult('cannot create a repository for another owner');
    let repo = store.get(owner, repoName);
    if (!repo) {
      repo = store.create(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    }
    return textResult(repoObject(repo));
  }
  if (match('getrepo')) {
    const repo = resolveRepo(store, args);
    if (!repo) return errorResult('repository not found');
    return textResult(repoObject(repo));
  }
  if (match('createissue')) {
    const repo = resolveRepo(store, args);
    if (!repo) return errorResult('repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    if (!title) return errorResult('create_issue requires a title');
    const number = repo.nextNumber++;
    const issue = {
      number,
      id: '',
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as { id: number; body: string; seq: number }[],
      seq: tickNow(),
    };
    repo.issues.push(issue);
    return textResult({ id: issueRestId(repo, number), number, title: issue.title, body: issue.body, state: 'open' });
  }
  if (match('listissues')) {
    const repo = resolveRepo(store, args);
    if (!repo) return errorResult('repository not found');
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    const items = list.map((i) => ({ id: issueRestId(repo, i.number), number: i.number, title: i.title, body: i.body, state: i.state }));
    return textResult({ issues: items });
  }
  if (match('createpullrequest')) {
    const repo = resolveRepo(store, args);
    if (!repo) return errorResult('repository not found');
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    const title = typeof args.title === 'string' ? args.title : '';
    if (!head || !title) return errorResult('create_pull_request requires head and title');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
    const number = repo.nextNumber++;
    const pull = {
      number,
      id: '',
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBase: repo.mergeBase(headSha, baseSha) ?? baseSha,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      seq: tickNow(),
    };
    repo.pulls.push(pull);
    return textResult({ id: pullRestId(repo, number), number, title, state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } });
  }
  if (match('mergepullrequest')) {
    const repo = resolveRepo(store, args);
    if (!repo) return errorResult('repository not found');
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return errorResult('pull request not found');
    if (!pull.merged) {
      const result = squashMerge(repo, pull);
      if (!result.ok) return errorResult('merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date(tickNow() * 1000).toISOString();
      pull.mergeCommitSha = result.sha;
    }
    return textResult({ id: pullRestId(repo, pull.number), number: pull.number, merged: true, state: 'closed', sha: pull.mergeCommitSha });
  }
  return errorResult(`unknown tool ${name}`);
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  h: Helpers,
  authed: boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    h.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const body = await h.readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700, regardless of auth.
    h.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!authed) {
    h.sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    h.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const msg = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const reply = (payload: unknown, status = 200): void => {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    h.sendJson(res, status, payload);
  };
  if (typeof msg.method !== 'string') {
    reply({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'server/discover': {
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [REVISION],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : REVISION;
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      reply(null);
      return true;
    }
    case 'ping': {
      reply({ jsonrpc: '2.0', id, result: {} });
      return true;
    }
    case 'tools/list': {
      reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name || name.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith(t.name.replace(/[^a-z0-9]/g, '')));
      if (!tool) {
        reply({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
        return true;
      }
      // Missing required arguments -> isError:true (the suite accepts that or -32602).
      const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length > 0) {
        reply({ jsonrpc: '2.0', id, result: errorResult(`missing required argument(s): ${missing.join(', ')}`) });
        return true;
      }
      const result = callTool(store, tool.name, args);
      reply({ jsonrpc: '2.0', id, result });
      return true;
    }
    default: {
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      return true;
    }
  }
}
