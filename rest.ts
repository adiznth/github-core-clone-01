// REST v3 API (/api/v3): repositories, branches, commits, contents, labels,
// issues, comments, pull requests, merges. Backed by the same git object
// store as the smart-HTTP surface, so SHAs agree across surfaces.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  tickNow,
  type Repo,
  type Store,
} from './store.ts';

export interface Helpers {
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  reqId: () => string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

function gitIdent(): string {
  return `${IDENTITY} ${tickNow()} +0000`;
}

// ---------------------------------------------------------------- tree helpers

function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const build = (dir: string): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const subdirs = new Set<string>();
    for (const [path, v] of flat) {
      if (!path.startsWith(dir)) continue;
      const rest = path.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: v.mode, name: rest, oid: v.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const d of subdirs) {
      entries.push({ mode: '40000', name: d, oid: build(dir + d + '/') });
    }
    return repo.putObject('tree', buildTree(entries));
  };
  return build('');
}

/** Commit a tree change on `branch` (creating the branch from the default
 *  tip when it does not exist yet). Returns the new commit sha. */
export function commitTreeChange(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (flat: Map<string, { oid: string; mode: string }>) => void,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parentTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : undefined;
  const flat = repo.flattenTree(parentTree);
  mutate(flat);
  const treeOid = buildTreeFromFlat(repo, flat);
  const ident = gitIdent();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip ? [tip] : [],
    author: ident,
    committer: ident,
    message,
  });
  const commitSha = repo.putObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

/** The tree oid at `segments` below `rootTree` (null when absent / not a tree). */
function treeAtPath(repo: Repo, rootTree: string | undefined, segments: string[]): string | null {
  let current = rootTree;
  for (const seg of segments) {
    if (!current) return null;
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current ?? null;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function diffLines(a: string, b: string): { additions: number; deletions: number } {
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  if (aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines[bLines.length - 1] === '') bLines.pop();
  const aCount = new Map<string, number>();
  for (const l of aLines) aCount.set(l, (aCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of bLines) {
    const c = aCount.get(l) ?? 0;
    if (c > 0) aCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of aCount.values()) deletions += c;
  return { additions, deletions };
}

// ---------------------------------------------------------------- serializers

export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://${host}/${repo.fullName}`,
    clone_url: `http://${host}/${repo.fullName}.git`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: new Date((1735689600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1735689600 + repo.createdSeq) * 1000).toISOString(),
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number], host: string): Record<string, unknown> {
  return {
    id: issueRestId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    html_url: `http://${host}/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    created_at: new Date((1735689600 + issue.seq) * 1000).toISOString(),
    updated_at: new Date((1735689600 + issue.seq) * 1000).toISOString(),
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number], host: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: pullRestId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    html_url: `http://${host}/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    created_at: new Date((1735689600 + pull.seq) * 1000).toISOString(),
    updated_at: new Date((1735689600 + pull.seq) * 1000).toISOString(),
  };
  if (pull.merged) {
    body.merged_at = pull.mergedAt;
    body.merge_commit_sha = pull.mergeCommitSha;
  }
  return body;
}

// Stable numeric ids for REST objects: global counters kept on the store.
const restIds = new WeakMap<object, Map<number, number>>();
let nextRestId = 1;
function restIdFor(owner: object, key: number): number {
  let m = restIds.get(owner);
  if (!m) {
    m = new Map();
    restIds.set(owner, m);
  }
  let id = m.get(key);
  if (id === undefined) {
    id = nextRestId++;
    m.set(key, id);
  }
  return id;
}
export function issueRestId(repo: Repo, number: number): number {
  return restIdFor(repo, number);
}
export function pullRestId(repo: Repo, number: number): number {
  return restIdFor(repo, number + 1000000);
}

// ---------------------------------------------------------------- merge

export function prFiles(repo: Repo, pull: Repo['pulls'][number]): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseCommit = repo.objects.get(pull.baseSha);
  const headCommit = repo.objects.get(pull.headSha);
  const baseTree = baseCommit ? parseCommit(baseCommit.data).tree : undefined;
  const headTree = headCommit ? parseCommit(headCommit.data).tree : undefined;
  const base = repo.flattenTree(baseTree);
  const head = repo.flattenTree(headTree);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const blob = repo.objects.get(b.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const deletions = countLines(text);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const blob = repo.objects.get(h.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const additions = countLines(text);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const bBlob = repo.objects.get(b.oid);
      const hBlob = repo.objects.get(h.oid);
      const { additions, deletions } = diffLines(bBlob ? bBlob.data.toString('utf8') : '', hBlob ? hBlob.data.toString('utf8') : '');
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Plan a squash merge without applying it. Returns the new tree when clean. */
export function planSquashMerge(
  repo: Repo,
  pull: Repo['pulls'][number],
): { conflict: true } | { conflict: false; newTree: Map<string, { oid: string; mode: string }>; baseTip: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { conflict: true };
  const mergeBase = repo.mergeBase(headTip, baseTip);
  const baseCommit = repo.objects.get(baseTip)!;
  const headCommit = repo.objects.get(headTip)!;
  const baseTree = repo.flattenTree(parseCommit(baseCommit.data).tree);
  const headTree = repo.flattenTree(parseCommit(headCommit.data).tree);
  const ancestorTree = mergeBase ? repo.flattenTree(parseCommit(repo.objects.get(mergeBase)!.data).tree) : new Map();
  // Changed paths in the PR (ancestor -> head).
  const changed = new Map<string, { oid: string; mode: string } | null>();
  const allPaths = new Set([...ancestorTree.keys(), ...headTree.keys()]);
  for (const path of allPaths) {
    const a = ancestorTree.get(path);
    const h = headTree.get(path);
    if ((a?.oid ?? null) !== (h?.oid ?? null)) changed.set(path, h ?? null);
  }
  // Conflict: a path changed on both sides since the merge-base, to different results.
  for (const [path, headVersion] of changed) {
    const ancestorVersion = ancestorTree.get(path);
    const baseVersion = baseTree.get(path);
    const baseChanged = (baseVersion?.oid ?? null) !== (ancestorVersion?.oid ?? null);
    if (!baseChanged) continue;
    const headOid = headVersion?.oid ?? null;
    const baseOid = baseVersion?.oid ?? null;
    if (headOid !== baseOid) return { conflict: true };
  }
  const newTree = new Map(baseTree);
  for (const [path, headVersion] of changed) {
    if (headVersion) newTree.set(path, headVersion);
    else newTree.delete(path);
  }
  return { conflict: false, newTree, baseTip };
}

/** Squash-merge a PR. Returns {ok, sha} or {conflict:true}. */
export function squashMerge(repo: Repo, pull: Repo['pulls'][number]): { ok: true; sha: string } | { ok: false; conflict: true } {
  const plan = planSquashMerge(repo, pull);
  if (plan.conflict) return { ok: false, conflict: true };
  const treeOid = buildTreeFromFlat(repo, plan.newTree);
  const ident = gitIdent();
  const commit = buildCommit({
    tree: treeOid,
    parents: [plan.baseTip],
    author: ident,
    committer: ident,
    message: pull.title,
  });
  const sha = repo.putObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return { ok: true, sha };
}

// ---------------------------------------------------------------- router

interface Ctx {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  host: string;
  body: Buffer;
  json: unknown; // parsed JSON body, or undefined when empty; null when malformed
  jsonMalformed: boolean;
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  h: Helpers,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (!url.pathname.startsWith('/api/v3')) return false;
  const segments = url.pathname.slice('/api/v3'.length).split('/').filter((s) => s !== '');
  const host = req.headers.host ?? 'localhost';
  const method = req.method ?? 'GET';
  const body = await h.readBody(req);
  let json: unknown;
  let jsonMalformed = false;
  if (body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      jsonMalformed = true;
    }
  }
  const ctx: Ctx = { method, segments, query: url.searchParams, host, body, json, jsonMalformed };
  const send = (status: number, b: unknown, headers: Record<string, string> = {}): void => {
    h.sendJson(res, status, b, headers);
  };
  const err = (status: number, message: string): void => send(status, { message });
  const notFound = (): void => err(404, 'Not Found');

  // Malformed JSON body on a JSON endpoint is 400 (only when a body was sent).
  if (jsonMalformed && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    err(400, 'malformed JSON body');
    return true;
  }
  const payload = (json ?? {}) as Record<string, unknown>;

  // GET /api/v3/ — API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(), true;
    send(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound(), true;
    send(200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound(), true;
    send(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    return true;
  }

  // POST /api/v3/user/repos  +  GET /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = String(payload.name ?? '');
      if (!name) return err(422, 'name is required'), true;
      if (store.get(VIEWER.login, name)) return err(422, `Repository ${name} already exists`), true;
      const repo = store.create(VIEWER.login, name, String(payload.description ?? ''), payload.private === true);
      send(201, repoJson(repo, host));
      return true;
    }
    if (method === 'GET') {
      const all = store.listByOwner(VIEWER.login);
      const perPage = Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
        const links = [`<${base}&page=${page + 1}>; rel="next"`, `<${base}&page=${totalPages}>; rel="last"`];
        if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`, `<${base}&page=1>; rel="first"`);
        headers.link = links.join(', ');
      }
      send(200, slice.map((r) => repoJson(r, host)), headers);
      return true;
    }
    return notFound(), true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const rest = segments.slice(3);
    if (owner !== VIEWER.login) return notFound(), true;
    const repo = store.get(owner, repoName);

    // GET /repos/{o}/{r}  PATCH  DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return notFound(), true;
        send(200, repoJson(repo, host));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) return notFound(), true;
        if (typeof payload.description === 'string') repo.description = payload.description;
        send(200, repoJson(repo, host));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) return notFound(), true;
        store.delete(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': h.reqId() });
        res.end();
        return true;
      }
      return notFound(), true;
    }
    if (!repo) return notFound(), true;

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = String(payload.ref ?? '');
      const sha = String(payload.sha ?? '');
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'invalid ref or sha'), true;
      if (!repo.objects.has(sha)) return err(422, 'object not found'), true;
      repo.refs.set(ref, sha.toLowerCase());
      send(201, { ref, object: { sha: sha.toLowerCase() } });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches: { name: string; commit: { sha: string } }[] = [];
      for (const [name, oid] of [...repo.refs.entries()].sort()) {
        if (name.startsWith('refs/heads/')) branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid } });
      }
      send(200, branches);
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam ? repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) : repo.headOid();
      const walk = repo.commitWalk(tip);
      send(200, walk.map((sha) => {
        const c = parseCommit(repo.objects.get(sha)!.data);
        return { sha, commit: { message: c.message } };
      }));
      return true;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = ctx.query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      if (method === 'PUT') {
        const contentB64 = String(payload.content ?? '');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(400, 'invalid base64 content'), true;
        }
        const message = String(payload.message ?? '');
        const putBranch = typeof payload.branch === 'string' ? payload.branch : branch;
        const tip = repo.refs.get(`refs/heads/${putBranch}`);
        const parentTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : undefined;
        const flat = repo.flattenTree(parentTree);
        const existing = flat.get(path);
        if (existing && typeof payload.sha === 'string' && payload.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'sha does not match the current blob'), true;
        }
        const blobSha = repo.putObject('blob', content);
        const isCreate = !existing;
        const sha = commitTreeChange(repo, putBranch, message, (f) => {
          f.set(path, { oid: blobSha, mode: '100644' });
        });
        send(isCreate ? 201 : 200, { content: { sha: blobSha, encoding: 'base64' }, commit: { sha } });
        return true;
      }
      if (method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const parentTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : undefined;
        const flat = repo.flattenTree(parentTree);
        const entry = flat.get(path);
        if (entry) {
          const blob = repo.objects.get(entry.oid)!;
          send(200, {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: entry.oid,
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
          });
          return true;
        }
        // Directory listing?
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        const dirTree = path === '' ? parentTree : treeAtPath(repo, parentTree, path.split('/'));
        if (dirTree) {
          for (const e of parseTree(repo.objects.get(dirTree)!.data)) {
            children.set(e.name, {
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: prefix + e.name,
              sha: e.oid,
            });
          }
          send(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
          return true;
        }
        return notFound(), true;
      }
      if (method === 'DELETE') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const parentTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : undefined;
        const flat = repo.flattenTree(parentTree);
        if (!flat.has(path)) return notFound(), true;
        const message = String(payload.message ?? '');
        const sha = commitTreeChange(repo, branch, message, (f) => {
          f.delete(path);
        });
        send(200, { commit: { sha } });
        return true;
      }
      return notFound(), true;
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const name = String(payload.name ?? '');
      if (!name) return err(422, 'name is required'), true;
      repo.labels.set(name, { name, color: String(payload.color ?? 'ededed') });
      send(201, { name });
      return true;
    }

    // /repos/{o}/{r}/issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = String(payload.title ?? '');
          const body = String(payload.body ?? '');
          const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) return err(422, `label ${l} does not exist`), true;
          }
          const number = repo.nextNumber++;
          const issue = {
            number,
            id: '',
            title,
            body,
            state: 'open' as const,
            labels: [...labels],
            comments: [] as { id: number; body: string; seq: number }[],
            seq: tickNow(),
          };
          issue.id = '';
          repo.issues.push(issue);
          send(201, issueJson(repo, issue, host));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = ctx.query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const direction = ctx.query.get('direction') ?? 'desc';
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const perPage = Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
          list = list.slice((page - 1) * perPage, page * perPage);
          send(200, list.map((i) => issueJson(repo, i, host)));
          return true;
        }
        return notFound(), true;
      }
      const num = parseInt(rest[1]!, 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return notFound(), true;
          send(200, issueJson(repo, issue, host));
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) return notFound(), true;
          if (payload.state === 'closed' || payload.state === 'open') issue.state = payload.state;
          send(200, issueJson(repo, issue, host));
          return true;
        }
        return notFound(), true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound(), true;
        if (method === 'POST') {
          const comment = { id: repo.nextCommentId++, body: String(payload.body ?? ''), seq: tickNow() };
          issue.comments.push(comment);
          send(201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          send(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
          return true;
        }
        return notFound(), true;
      }
      return notFound(), true;
    }

    // /repos/{o}/{r}/pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const headRef = String(payload.head ?? '');
          const baseRef = String(payload.base ?? repo.defaultBranch);
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist'), true;
          const mergeBase = repo.mergeBase(headSha, baseSha) ?? baseSha;
          const number = repo.nextNumber++;
          const pull = {
            number,
            id: '',
            title: String(payload.title ?? ''),
            body: String(payload.body ?? ''),
            state: 'open' as const,
            headRef,
            baseRef,
            headSha,
            baseSha,
            mergeBase,
            merged: false,
            mergedAt: null as string | null,
            mergeCommitSha: null as string | null,
            seq: tickNow(),
          };
          repo.pulls.push(pull);
          send(201, pullJson(repo, pull, host));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = ctx.query.get('state');
          if (state === 'all') {
            // keep all
          } else if (state) {
            list = list.filter((p) => p.state === state);
          } else {
            list = list.filter((p) => p.state === 'open');
          }
          const perPage = Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
          list = list.slice((page - 1) * perPage, page * perPage);
          send(200, list.map((p) => pullJson(repo, p, host)));
          return true;
        }
        return notFound(), true;
      }
      const num = parseInt(rest[1]!, 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return notFound(), true;
          send(200, pullJson(repo, pull, host));
          return true;
        }
        return notFound(), true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return notFound(), true;
        send(200, prFiles(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return notFound(), true;
        if (pull.merged) {
          send(200, { merged: true, sha: pull.mergeCommitSha, message: 'already merged' });
          return true;
        }
        const result = squashMerge(repo, pull);
        if (!result.ok) return err(405, 'merge conflict'), true;
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = new Date(tickNow() * 1000).toISOString();
        pull.mergeCommitSha = result.sha;
        send(200, { merged: true, sha: result.sha, message: `Merge pull request #${pull.number}` });
        return true;
      }
      return notFound(), true;
    }

    return notFound(), true;
  }

  return notFound(), true;
}
