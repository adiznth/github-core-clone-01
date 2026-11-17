// Shared in-memory store + git object model for the forge.
// Only Node built-ins: node:crypto, node:zlib. No wall clock: a logical
// counter drives every timestamp so two runs stay identical.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const DEFAULT_BRANCH = 'main';
export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch

/** Monotonic logical clock: every timestamp in the forge comes from here. */
let tick = 0;
export function tickNow(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}
export function isoNow(): string {
  return new Date(tickNow() * 1000).toISOString();
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // "Name <email> ts +0000"
  committer: string;
  message: string;
}

export function buildCommit(c: CommitInfo): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry { mode: string; name: string; oid: string }

/** Git tree ordering: a directory name compares as if suffixed with '/'. */
function treeKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeKey(a) < treeKey(b) ? -1 : treeKey(a) > treeKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface TagInfo { object: string; type: ObjType; tag: string; tagger: string; message: string }

export function buildTag(t: TagInfo): Buffer {
  return Buffer.from(`object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${t.tagger}\n\n${t.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a pack object header varint: first byte holds type (bits 4-6) + size low 4 bits. */
function readObjHeader(buf: Buffer, off: number): { typeNum: number; size: number; next: number } {
  const b0 = buf[off];
  const typeNum = (b0 >> 4) & 0x07;
  let size = b0 & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    size |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { typeNum, size, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let s = 0;
    while (true) {
      const b = delta[p++];
      v |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[p++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      outLen += op;
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Parse a packfile. `resolveBase` supplies objects the pack's REF_DELTAs may name (thin packs). */
export function parsePack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check.
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n++) {
    const entryOff = off;
    const { typeNum, size, next } = readObjHeader(buf, off);
    off = next;
    let obj: GitObject;
    if (typeNum >= 1 && typeNum <= 4) {
      const inflated = inflateAt(buf, off);
      if (inflated.data.length !== size) throw new Error('object size mismatch');
      obj = { type: PACK_TYPES[typeNum]!, data: inflated.data };
      off = inflated.next;
    } else if (typeNum === 6) {
      // OFS_DELTA: offset encoding.
      let b = buf[off++];
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseEntryOff = entryOff - baseOff;
      const base = byOffset.get(baseEntryOff);
      if (!base) throw new Error('ofs-delta base not in pack');
      const inflated = inflateAt(buf, off);
      const data = applyDelta(base.data, inflated.data);
      obj = { type: base.type, data };
      off = inflated.next;
    } else if (typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateAt(buf, off);
      let base = objects.get(baseOid);
      if (!base && resolveBase) base = resolveBase(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} missing`);
      const data = applyDelta(base.data, inflated.data);
      obj = { type: base.type, data };
      off = inflated.next;
    } else {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOff, obj);
  }
  if (off !== buf.length - 20) throw new Error('pack trailing bytes');
  return objects;
}

/**
 * Inflate exactly one zlib stream starting at `off`; returns the data and the
 * offset just past the stream. Found by exponential probe + binary search for
 * the smallest slice that inflates cleanly (a zlib stream is self-terminating:
 * only a slice ending exactly at its end inflates, or the minimal such end
 * when trailing bytes are tolerated).
 */
export function inflateAt(buf: Buffer, off: number): { data: Buffer; next: number } {
  let probe = off + 16;
  let found = -1;
  while (probe <= buf.length) {
    try {
      inflateSync(buf.subarray(off, probe));
      found = probe;
      break;
    } catch {
      const nextProbe = probe * 2 - off;
      probe = nextProbe > buf.length ? buf.length : nextProbe;
      if (probe <= off) break;
    }
  }
  if (found < 0) {
    try {
      inflateSync(buf.subarray(off));
      found = buf.length;
    } catch {
      throw new Error('zlib stream not found');
    }
  }
  let lo = off + 1;
  let hi = found;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(off, lo)), next: lo };
}

/** Serialize objects as a plain (delta-free) packfile v2. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    // Varint header: type in bits 4-6, size low 4 bits first.
    const bytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    bytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// ---------------------------------------------------------------- repo store

export interface IssueComment { id: number; body: string; seq: number }
export interface Issue {
  number: number;
  id: string; // global node id (opaque)
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}
export interface Pull {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export class Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = DEFAULT_BRANCH;
  databaseId: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // 'refs/heads/x' | 'refs/tags/x' -> oid
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, { name: string; color: string }>();
  nextNumber = 1;
  nextCommentId = 1;
  createdSeq: number;

  constructor(owner: string, name: string, description: string, isPrivate: boolean, databaseId: number) {
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.databaseId = databaseId;
    this.createdSeq = tickNow();
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  headOid(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Walk parents from `tip` (inclusive). Returns commit oids newest-first. */
  commitWalk(tip: string | undefined, limit = 10000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = tip ? [tip] : [];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  /** All objects reachable from `tips` (commits, trees, blobs, tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
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

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  mergeBase(a: string, b: string): string | null {
    const ancA = new Set(this.commitWalk(a));
    const walkB = this.commitWalk(b);
    for (const oid of walkB) if (ancA.has(oid)) return oid;
    return null;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(treeOid: string | undefined, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (!treeOid) return out;
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner + '/' + name
  nextRepoId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  create(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(owner, name, description, isPrivate, this.nextRepoId++);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  delete(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}

/** Global node ids: opaque base64, stable across reads. */
export function nodeId(kind: string, ref: string): string {
  return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64');
}

export function decodeNodeId(id: string): { kind: string; ref: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), ref: text.slice(i + 1) };
  } catch {
    return null;
  }
}
