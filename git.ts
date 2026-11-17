// Git smart HTTP: pkt-line framing, advertisements, upload-pack v2 (+v0),
// receive-pack v0, packfile generation. No git binary anywhere.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  parsePack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from the start of `buf`. Stops at the first flush and
 *  returns the packets plus the byte offset just past it (pack bytes follow). */
export function parsePktLines(buf: Buffer): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, next: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return { packets, next: off };
}

/** Split pack bytes into sideband band-1 pkt-lines (max 65520 raw bytes each). */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 (length) - 1 (band byte)
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------- ref helpers

function allRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The commit an annotated tag ref peels to (null when the ref is not a tag object). */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'makefun-forge/1.0';

function advertiseUploadPackV2(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function advertiseUploadPackV0(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  const head = repo.headOid() ?? ZERO_OID;
  const refs = allRefs(repo);
  if (refs.length === 0) {
    lines.push(pkt(`${head} HEAD\0${caps}\n`));
  } else {
    lines.push(pkt(`${head} HEAD\0${caps}\n`));
    for (const r of refs) {
      lines.push(pkt(`${r.oid} ${r.name}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) lines.push(pkt(`${peeled} ${r.name}^{}\n`));
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function advertiseReceivePack(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Buffer[] = [pkt('# service=git-receive-pack\n'), FLUSH];
  const head = repo.headOid() ?? ZERO_OID;
  const refs = allRefs(repo);
  if (refs.length === 0) {
    lines.push(pkt(`${head} HEAD\0${caps}\n`));
  } else {
    lines.push(pkt(`${head} HEAD\0${caps}\n`));
    for (const r of refs) {
      lines.push(pkt(`${r.oid} ${r.name}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) lines.push(pkt(`${peeled} ${r.name}^{}\n`));
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: GitObject[]; // objects to send (with oids implied by content)
  shallow: string[];
  unshallow: string[];
}

function resolveCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    return resolveCommit(repo, target);
  }
  return null;
}

/** Commit generations from `roots` (tag-resolved), gen 0 = roots. */
function generations(repo: Repo, roots: string[]): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    const c = resolveCommit(repo, r);
    if (c && !gen.has(c)) {
      gen.set(c, 0);
      queue.push(c);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const g = gen.get(oid)!;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!gen.has(p)) {
        gen.set(p, g + 1);
        queue.push(p);
      }
    }
  }
  return gen;
}

/** Reachable objects from `tips`, not following parent links out of `stopAt` commits
 * (their trees are still included). Used for shallow fetches: the boundary commits
 * are leaves for the client, and a shallow client's haves carry the same cut. */
function reachableCut(repo: Repo, tips: Iterable<string>, stopAt: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!stopAt.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  prevShallow: string[],
): FetchPlan {
  // What the client already holds. A shallow client's haves are cut at its
  // boundaries, so a plain full-history walk would wrongly exclude objects
  // the client does not have (the deepen case).
  const haveReachable =
    prevShallow.length > 0 ? reachableCut(repo, haves, new Set(prevShallow)) : repo.reachable(haves);
  let sendTips: string[] = wants;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined) {
    const gen = generations(repo, wants);
    const included = new Set<string>();
    for (const [oid, g] of gen) if (g < depth) included.add(oid);
    const boundary = new Set<string>();
    for (const [oid, g] of gen) {
      if (g !== depth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.add(oid);
    }
    shallow = [...boundary].sort();
    for (const old of prevShallow) {
      const g = gen.get(old);
      if (g !== undefined && g < depth - 1) unshallow.push(old);
    }
    unshallow.sort();
    sendTips = [...included];
  }
  // Reachable objects from the send tips, minus what the client already has.
  // With a depth limit the walk stops at the boundary commits: their parents
  // are not sent.
  const reachable =
    depth !== undefined
      ? reachableCut(repo, sendTips, new Set(shallow))
      : repo.reachable(sendTips);
  const objects: GitObject[] = [];
  for (const oid of reachable) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic order: commits, then trees, then blobs, then tags, by oid.
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 } as const;
  objects.sort((a, b) => {
    const ra = rank[a.type] - rank[b.type];
    if (ra !== 0) return ra;
    return 0;
  });
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- upload-pack

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const head = repo.headOid();
  if (keep('HEAD')) {
    if (head) {
      out.push(pkt(`${head} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (args.includes('unborn')) {
      out.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const r of allRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (wantPeel) {
      const peeled = peeledOid(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV2Response(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const prevShallow: string[] = [];
  let depth: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) prevShallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, prevShallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), DELIM];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, section1: string[], haves: string[]): Buffer {
  const wants: string[] = [];
  const prevShallow: string[] = [];
  let depth: number | undefined;
  for (const a of section1) {
    if (a.startsWith('want ')) wants.push(a.slice(5).split(' ')[0]);
    else if (a.startsWith('shallow ')) prevShallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, prevShallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-upload-pack-result';
  let packets: Packet[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  // Split data-packet lines into sections at delim (v2) / flush (v0).
  const sections: string[][] = [[]];
  for (const p of packets) {
    if (p.kind === 'delim' || p.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (p.kind === 'data') sections[sections.length - 1]!.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (isV2) {
    const cmdLines = sections[0] ?? [];
    const argLines = sections[1] ?? [];
    const command = cmdLines.find((l) => l.startsWith('command='))?.slice('command='.length);
    if (command === 'ls-refs') {
      return { status: 200, contentType: CT, body: lsRefsResponse(repo, argLines) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: CT, body: fetchV2Response(repo, argLines) };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${command ?? ''}` })) };
  }
  // v0: two sections split by the flush.
  const section1 = sections[0] ?? [];
  const section2 = sections[1] ?? [];
  const haves = section2.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
  return { status: 200, contentType: CT, body: fetchV0Response(repo, section1, haves) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string }

function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-receive-pack-result';
  let parsed: { packets: Packet[]; next: number };
  try {
    parsed = parsePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  const commands: PushCommand[] = [];
  let caps = '';
  for (const p of parsed.packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && caps === '') caps = text.slice(nul + 1);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) continue;
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  const sideBand = caps.split(' ').includes('side-band-64k');
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasObjects = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (hasObjects) {
    const packBytes = body.subarray(parsed.next);
    if (packBytes.length > 0) {
      try {
        incoming = parsePack(packBytes, (oid) => repo.objects.get(oid));
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (unpackOk) {
    // Store every unpacked object first (git unpacks before updating refs).
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${cmd.ref} ref does not exist`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        report.push(`ng ${cmd.ref} old value mismatch`);
      } else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} already exists`);
      } else if (!repo.objects.has(cmd.newOid)) {
        report.push(`ng ${cmd.ref} object not found`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // Update: must fast-forward.
    if (current === undefined) {
      report.push(`ng ${cmd.ref} ref does not exist`);
    } else if (cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} old value mismatch`);
    } else if (!repo.objects.has(cmd.newOid)) {
      report.push(`ng ${cmd.ref} object not found`);
    } else if (!isFastForward(repo, cmd.oldOid, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    }
  }
  const lines: Buffer[] = [pkt(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const r of report) lines.push(pkt(`${r}\n`));
  lines.push(FLUSH);
  if (sideBand) {
    const framed: Buffer[] = [];
    for (const l of lines) framed.push(pkt(Buffer.concat([Buffer.from([1]), l])));
    framed.push(FLUSH);
    return { status: 200, contentType: CT, body: Buffer.concat(framed) };
  }
  return { status: 200, contentType: CT, body: Buffer.concat(lines) };
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------- router

export function gitPathParts(path: string): { owner: string; repo: string; rest: string } | null {
  // /{owner}/{repo}.git/<rest>
  const m = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, rest: m[3] ?? '' };
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  rest: string,
  query: URLSearchParams,
  readBody: () => Promise<Buffer>,
  sendRaw: (status: number, contentType: string, body: Buffer) => void,
): Promise<void> {
  const repo = store.get(owner, repoName);
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service');
    if (!repo) {
      sendRaw(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return;
    }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) sendRaw(200, 'application/x-git-upload-pack-advertisement', advertiseUploadPackV2());
      else sendRaw(200, 'application/x-git-upload-pack-advertisement', advertiseUploadPackV0(repo));
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(200, 'application/x-git-receive-pack-advertisement', advertiseReceivePack(repo));
      return;
    }
    sendRaw(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    return;
  }
  if (method === 'POST' && rest === 'git-upload-pack') {
    if (!repo) {
      sendRaw(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return;
    }
    const body = await readBody();
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' || body.subarray(0, 20).toString('ascii').includes('command=');
    const out = handleUploadPack(repo, body, isV2);
    sendRaw(out.status, out.contentType, out.body);
    return;
  }
  if (method === 'POST' && rest === 'git-receive-pack') {
    if (!repo) {
      sendRaw(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return;
    }
    const body = await readBody();
    const out = handleReceivePack(repo, body);
    sendRaw(out.status, out.contentType, out.body);
    return;
  }
  sendRaw(404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
}

export { hashObject };
