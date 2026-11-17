// GraphQL v4 (/api/graphql): a small parser + executor for the documents gh
// and github-mcp-server send. Supports queries, mutations, variables, aliases,
// inline fragments, __type introspection, and batched (array) bodies.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  decodeNodeId,
  nodeId,
  tickNow,
  type Repo,
  type Store,
} from './store.ts';
import { planSquashMerge, prFiles, squashMerge } from './rest.ts';
import type { Helpers } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=[]@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const e = input[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '$') {
      tokens.push({ kind: 'punct', value: '$' });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefs: { name: string; type: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}
interface FragmentDef { name: string; typeCondition: string; selections: SelectionNode[] }
interface Document { operations: Operation[]; fragments: Map<string, FragmentDef> }

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push(this.parseOperation('query', null, []));
        continue;
      }
      const word = this.expectName();
      if (word === 'query' || word === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefs = this.parseVariableDefs();
        operations.push(this.parseOperation(word, name, variableDefs));
      } else if (word === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        const selections = this.parseSelections();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new Error(`unexpected ${word}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): Operation['variableDefs'] {
    const defs: Operation['variableDefs'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        defs.push({ name, type, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    while (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseOperation(kind: 'query' | 'mutation', name: string | null, variableDefs: Operation['variableDefs']): Operation {
    const selections = this.parseSelections();
    return { kind, name, variableDefs, selections };
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (n.kind === 'name') {
        return { kind: 'spread', name: this.expectName() };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelections() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue(false) });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('variable in const value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- values

type Json = unknown;

function resolveValue(node: ValueNode, variables: Record<string, Json>): Json {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, Json> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema data

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'mergeCommit'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

// ---------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
  variables: Record<string, Json>;
  fragments: Map<string, FragmentDef>;
  errors: { message: string; path?: (string | number)[] }[];
}

type ParentValue =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'User'; login: string }
  | { __type: 'Issue'; repo: Repo; issue: Repo['issues'][number] }
  | { __type: 'IssueConnection'; repo: Repo; nodes: Repo['issues'][number][]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequest'; repo: Repo; pull: Repo['pulls'][number] }
  | { __type: 'PullRequestConnection'; repo: Repo; nodes: Repo['pulls'][number][] }
  | { __type: 'PullRequestChangedFile'; filename: string }
  | { __type: 'PRFileConnection'; nodes: { filename: string }[] }
  | { __type: 'CreateIssueResult'; repo: Repo; issue: Repo['issues'][number] }
  | { __type: 'CreatePullRequestResult'; repo: Repo; pull: Repo['pulls'][number] }
  | { __type: 'AddCommentResult'; repo: Repo; issue: Repo['issues'][number]; comment: { id: number; body: string } }
  | { __type: 'BranchRef'; name: string; oid?: string }
  | { __type: 'Type'; name: string }
  | { __type: 'CommentEdge'; repo: Repo; issue: Repo['issues'][number]; comment: { id: number; body: string } }
  | { __type: 'Comment'; repo: Repo; issue: Repo['issues'][number]; comment: { id: number; body: string } };

const TYPE_NAMES: Record<string, string> = {
  Query: 'Query',
  Mutation: 'Mutation',
  Repository: 'Repository',
  User: 'User',
  Issue: 'Issue',
  IssueConnection: 'IssueConnection',
  PageInfo: 'PageInfo',
  PullRequest: 'PullRequest',
  PullRequestConnection: 'PullRequestConnection',
  PullRequestChangedFile: 'PullRequestChangedFile',
  BranchRef: 'Ref',
  Type: '__Type',
  CommentEdge: 'IssueCommentEdge',
  Comment: 'IssueComment',
  PRFileConnection: 'PullRequestChangedFileConnection',
};

function fieldError(ctx: ExecCtx, parent: ParentValue, field: FieldNode): void {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${TYPE_NAMES[parent.__type] ?? parent.__type}".` });
}

function executeSelections(ctx: ExecCtx, parent: ParentValue, selections: SelectionNode[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) Object.assign(out, executeSelections(ctx, parent, frag.selections));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== TYPE_NAMES[parent.__type] && sel.typeCondition !== parent.__type) continue;
      Object.assign(out, executeSelections(ctx, parent, sel.selections));
      continue;
    }
    const f = sel.field;
    const key = f.alias ?? f.name;
    out[key] = executeField(ctx, parent, f);
  }
  return out;
}

function executeField(ctx: ExecCtx, parent: ParentValue, field: FieldNode): Json {
  const args = argMap(field, ctx.variables);
  const subs = field.selections;
  const need = (v: Json): Json => {
    if (subs === null) return v;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && '__type' in (v as Record<string, unknown>)) {
      return executeSelections(ctx, v as ParentValue, subs);
    }
    return v;
  };
  switch (parent.__type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return need({ __type: 'User', login: VIEWER.login });
      }
      if (field.name === 'repository') {
        const repo = findRepo(ctx.store, String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return null;
        return need({ __type: 'Repository', repo });
      }
      if (field.name === 'node') {
        const decoded = decodeNodeId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const [owner, name] = decoded.ref.split('/');
          const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
          if (!repo) return null;
          return need({ __type: 'Repository', repo });
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'Issue' || name === 'PullRequest' || name === 'Repository' || name === 'SearchType') {
          return need({ __type: 'Type', name });
        }
        return null;
      }
      fieldError(ctx, parent, field);
      return null;
    }
    case 'Mutation': {
      return executeMutation(ctx, field, args, subs);
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id': return nodeId('repo', repo.fullName);
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'description': return repo.description;
        case 'owner': return need({ __type: 'User', login: repo.owner });
        case 'defaultBranchRef': {
          const tip = repo.headOid();
          if (!tip) return null;
          return need({ __type: 'BranchRef', name: repo.defaultBranch, oid: tip });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `/repos/${repo.fullName}`;
        case 'createdAt': return new Date((1735689600 + repo.createdSeq) * 1000).toISOString();
        case 'updatedAt': return new Date((1735689600 + repo.createdSeq) * 1000).toISOString();
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          if (!issue) return null;
          return need({ __type: 'Issue', repo, issue });
        }
        case 'issues': return need(issuesConnection(ctx, repo, args));
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === Number(args.number));
          if (!pull) return null;
          return need({ __type: 'PullRequest', repo, pull });
        }
        case 'pullRequests': return need(pullsConnection(repo, args));
        default:
          fieldError(ctx, parent, field);
          return null;
      }
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id': return nodeId('issue', `${parent.repo.fullName}#${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'url': return `/repos/${parent.repo.fullName}/issues/${issue.number}`;
        case 'createdAt': return new Date((1735689600 + issue.seq) * 1000).toISOString();
        case 'updatedAt': return new Date((1735689600 + issue.seq) * 1000).toISOString();
        case 'author': return need({ __type: 'User', login: VIEWER.login });
        case 'labels': return { nodes: issue.labels.map((n) => ({ name: n })) };
        case 'comments': return { nodes: issue.comments.map((c) => ({ id: String(c.id), body: c.body })) };
        default:
          fieldError(ctx, parent, field);
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return parent.nodes.map((issue) => need({ __type: 'Issue', repo: parent.repo, issue }));
      }
      if (field.name === 'pageInfo') {
        return need({ __type: 'PageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor });
      }
      if (field.name === 'totalCount') return parent.nodes.length;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return parent.endCursor;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id': return nodeId('pr', `${parent.repo.fullName}#${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return mergeableOf(parent.repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return need({ __type: 'BranchRef', name: pull.headRef, oid: pull.headSha });
        case 'baseRef': return need({ __type: 'BranchRef', name: pull.baseRef, oid: pull.baseSha });
        case 'url': return `/repos/${parent.repo.fullName}/pull/${pull.number}`;
        case 'createdAt': return new Date((1735689600 + pull.seq) * 1000).toISOString();
        case 'updatedAt': return new Date((1735689600 + pull.seq) * 1000).toISOString();
        case 'author': return need({ __type: 'User', login: VIEWER.login });
        case 'mergeCommit': return pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = prFilesOf(parent.repo, pull).slice(0, first);
          return need({ __type: 'PRFileConnection', nodes: files });
        }
        default:
          fieldError(ctx, parent, field);
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return parent.nodes.map((pull) => need({ __type: 'PullRequest', repo: parent.repo, pull }));
      }
      if (field.name === 'totalCount') return parent.nodes.length;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'PRFileConnection': {
      if (field.name === 'nodes') {
        return parent.nodes.map((f) => need({ __type: 'PullRequestChangedFile', filename: f.filename }));
      }
      if (field.name === 'totalCount') return parent.nodes.length;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.filename;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'BranchRef': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'target') return parent.oid ? { oid: parent.oid } : null;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'Type': {
      if (field.name === 'fields') {
        const list = parent.name === 'Issue' ? ISSUE_FIELDS : parent.name === 'PullRequest' ? PR_FIELDS : parent.name === 'Repository' ? REPO_FIELDS : [];
        return list.map((n) => ({ name: n }));
      }
      if (field.name === 'enumValues') {
        if (parent.name === 'SearchType') return SEARCH_ENUM.map((n) => ({ name: n }));
        return [];
      }
      if (field.name === 'name') return parent.name;
      fieldError(ctx, parent, field);
      return null;
    }
    case 'CreateIssueResult': {
      if (field.name === 'issue') return need({ __type: 'Issue', repo: parent.repo, issue: parent.issue });
      fieldError(ctx, parent, field);
      return null;
    }
    case 'CreatePullRequestResult': {
      if (field.name === 'pullRequest') return need({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull });
      fieldError(ctx, parent, field);
      return null;
    }
    case 'AddCommentResult': {
      if (field.name === 'commentEdge') return need({ __type: 'CommentEdge', repo: parent.repo, issue: parent.issue, comment: parent.comment });
      fieldError(ctx, parent, field);
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return need({ __type: 'Comment', repo: parent.repo, issue: parent.issue, comment: parent.comment });
      fieldError(ctx, parent, field);
      return null;
    }
    case 'Comment': {
      if (field.name === 'id') return nodeId('comment', `${parent.repo.fullName}#${parent.issue.number}:${parent.comment.id}`);
      if (field.name === 'body') return parent.comment.body;
      fieldError(ctx, parent, field);
      return null;
    }
    default:
      fieldError(ctx, parent, field);
      return null;
  }
}

function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return store.get(owner, name);
}

function issuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, Json>): ParentValue {
  void ctx;
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && String(orderBy.field ?? '').toUpperCase() === 'CREATED_AT') {
    const desc = String(orderBy.direction ?? 'DESC').toUpperCase() === 'DESC';
    list.sort((a, b) => (desc ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) {
    const desc = orderBy && String(orderBy.direction ?? 'DESC').toUpperCase() === 'DESC';
    list = list.filter((i) => (desc ? i.number < after : i.number > after));
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return { __type: 'IssueConnection', repo, nodes: page, hasNextPage, endCursor };
}

function pullsConnection(repo: Repo, args: Record<string, Json>): ParentValue {
  const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
  const list = [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first);
  return { __type: 'PullRequestConnection', repo, nodes: list };
}

function encodeCursor(number: number): string {
  return Buffer.from(`n:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('n:')) return null;
    const n = parseInt(text.slice(2), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function prFilesOf(repo: Repo, pull: Repo['pulls'][number]): { filename: string }[] {
  return prFiles(repo, pull).map((f) => ({ filename: f.filename }));
}

function mergeableOf(repo: Repo, pull: Repo['pulls'][number]): string {
  if (pull.merged) return 'MERGEABLE';
  const plan = planSquashMerge(repo, pull);
  return plan.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function executeMutation(ctx: ExecCtx, field: FieldNode, args: Record<string, Json>, subs: SelectionNode[] | null): Json {
  const need = (v: Json): Json => {
    if (subs === null) return v;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && '__type' in (v as Record<string, unknown>)) {
      return executeSelections(ctx, v as ParentValue, subs);
    }
    return v;
  };
  const input = (args.input ?? {}) as Record<string, Json>;
  if (field.name === 'createIssue') {
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'repo') return need({ issue: null });
    const [owner, name] = decoded.ref.split('/');
    const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
    if (!repo) return need({ issue: null });
    const number = repo.nextNumber++;
    const issue = {
      number,
      id: '',
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as { id: number; body: string; seq: number }[],
      seq: tickNow(),
    };
    repo.issues.push(issue);
    return need({ __type: 'CreateIssueResult', repo, issue });
  }
  if (field.name === 'closeIssue') {
    const decoded = decodeNodeId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'issue') return need({ issue: null });
    const [ownerRepo, numStr] = decoded.ref.split('#');
    const [owner, name] = (ownerRepo ?? '').split('/');
    const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(numStr));
    if (!issue) return need({ issue: null });
    issue.state = 'closed';
    return need({ __type: 'CreateIssueResult', repo: repo!, issue });
  }
  if (field.name === 'createPullRequest') {
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'repo') return need({ pullRequest: null });
    const [owner, name] = decoded.ref.split('/');
    const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
    if (!repo) return need({ pullRequest: null });
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return need({ pullRequest: null });
    const number = repo.nextNumber++;
    const pull = {
      number,
      id: '',
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBase: repo.mergeBase(headSha, baseSha) ?? baseSha,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      seq: tickNow(),
    };
    repo.pulls.push(pull);
    return need({ __type: 'CreatePullRequestResult', repo, pull });
  }
  if (field.name === 'mergePullRequest') {
    const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'pr') return need({ pullRequest: null });
    const [ownerRepo, numStr] = decoded.ref.split('#');
    const [owner, name] = (ownerRepo ?? '').split('/');
    const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number(numStr));
    if (!pull) return need({ pullRequest: null });
    if (!pull.merged) {
      const result = squashMerge(repo!, pull);
      if (result.ok) {
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = new Date(tickNow() * 1000).toISOString();
        pull.mergeCommitSha = result.sha;
      }
    }
    return need({ __type: 'CreatePullRequestResult', repo: repo!, pull });
  }
  if (field.name === 'addComment') {
    const decoded = decodeNodeId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'issue') return need({ commentEdge: null });
    const [ownerRepo, numStr] = decoded.ref.split('#');
    const [owner, name] = (ownerRepo ?? '').split('/');
    const repo = owner && name ? findRepo(ctx.store, owner, name) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(numStr));
    if (!issue) return need({ commentEdge: null });
    const comment = { id: repo!.nextCommentId++, body: String(input.body ?? ''), seq: tickNow() };
    issue.comments.push(comment);
    return need({ __type: 'AddCommentResult', repo: repo!, issue, comment });
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------- HTTP entry

export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  h: Helpers,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    h.sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const body = await h.readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    h.sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
    return true;
  }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (typeof op !== 'object' || op === null) {
      return { errors: [{ message: 'expected an operation object' }] };
    }
    const { query, variables } = op as { query?: unknown; variables?: unknown };
    if (typeof query !== 'string') {
      return { errors: [{ message: 'query must be a string' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const opNode = doc.operations[0];
    if (!opNode) return { errors: [{ message: 'no operation in document' }] };
    const vars = (variables ?? {}) as Record<string, Json>;
    const ctx: ExecCtx = { store, variables: vars, fragments: doc.fragments, errors: [] };
    const root: ParentValue = opNode.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
    const data = executeSelections(ctx, root, opNode.selections);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    h.sendJson(res, 200, parsed.map(runOne));
  } else {
    h.sendJson(res, 200, runOne(parsed));
  }
  return true;
}
