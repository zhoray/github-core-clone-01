 // Verdant Forge — GraphQL v4 subset engine + schema (original implementation).
export type Value = { kind: 'var'; name: string } | { kind: 'lit'; value: any } | { kind: 'list'; items: Value[] } | { kind: 'object'; fields: { name: string; value: Value }[] };
export interface FieldSel { kind: 'field'; alias: string | null; name: string; args: { name: string; value: Value }[]; directives: { name: string; args: { name: string; value: Value }[] }[]; selectionSet: Selection[] | null };
export type Selection = FieldSel | { kind: 'spread'; name: string } | { kind: 'inline'; typeCondition: string | null; selectionSet: Selection[] };
export interface Operation { type: 'query' | 'mutation'; name: string | null; varDefs: { name: string; def: Value | null }[]; selectionSet: Selection[] };
export interface GqlDoc { operations: Operation[]; fragments: Map<string, { typeCondition: string; selectionSet: Selection[] }> };
export function tokenize(src: string): { t: string; v?: string }[] {
    const tokens: { t: string; v?: string }[] = [];
    let i = 0;
    const len = src.length;
    while (i < len) {
        while (i < len && /\s/.test(src[i])) i++;
        if (i >= len) break;
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '#') {
            while (i < len && src[i] !== '\n') i++;
            continue;
        }
        if (src[i] === '.' && src[i+1] === '.' && src[i+2] === '.') {
            tokens.push({ t: 'spread', v: '...' });
            i += 3;
            continue;
        }
        if (src[i].match(/[A-Za-z_]/)) {
            let start = i;
            while (i < len && src[i].match(/[A-Za-z0-9_]/)) i++;
            const name = src.substring(start, i);
            tokens.push({ t: 'name', v: name });
            continue;
        }
        if (src[i].match(/[-0-9]/)) {
            let start = i;
            while (i < len && /[0-9.eE+-]/.test(src[i])) i++;
            const num = src.substring(start, i);
            const isNum = num.includes('.') || num.includes('e') || num.includes('E') || num.includes('+') || num.includes('-');
            tokens.push({ t: isNum ? 'float' : 'int', v: num });
            continue;
        }
        if (src[i] === '"') {
            let start = i;
            i++;
            let str = '';
            while (i < len && src[i] !== '"') {
                if (src[i] === '\\') {
                    i++;
                    if (i >= len) break;
                    const esc = src[i];
                    switch(esc) {
                        case '"': str += '"'; break;
                        case '\\': str += '\\'; break;
                        case '/': str += '/'; break;
                        case 'n': str += '\n'; break;
                        case 'r': str += '\r'; break;
                        case 't': str += '\t'; break;
                        case 'b': str += '\b'; break;
                        case 'f': str += '\f'; break;
                        case 'u':
                            if (i + 4 < len) {
                                str += String.fromCharCode(parseInt(src.substring(i + 1, i + 5), 16));
                                i += 4;
                            }
                            break;
                        default: str += esc; break;
                    }
                    i++;
                    continue;
                }
                str += src[i];
                i++;
            }
            if (i < len) i++;
            tokens.push({ t: 'string', v: str });
            continue;
        }
        if (src[i] === '"' && src[i+1] === '"' && src[i+2] === '"') {
            let start = i;
            i += 3;
            let str = '';
            while (i < len && !(src[i] === '"' && src[i+1] === '"' && src[i+2] === '"')) {
                str += src[i];
                i++;
            }
            if (i < len) i += 3;
            tokens.push({ t: 'string', v: str });
            continue;
        }
        const punct = '!$():=@[ ]{}|&';
        if (punct.includes(src[i])) {
            tokens.push({ t: 'punct', v: src[i] });
            i++;
            continue;
        }
        i++;
    }
    return tokens;
}
export class Parser {
  private tokens: { t: string; v?: string }[];
  private pos: number = 0;
  constructor(tokens: { t: string; v?: string }[]) {
    this.tokens = tokens;
  }
  private peek(): { t: string; v?: string } | null {
    if (this.pos >= this.tokens.length) return null;
    return this.tokens[this.pos];
  }
  private consume(t: string): void {
    const p = this.peek();
    if (!p || p.t !== t) {
      throw new Error(`Expected token ${t} but got ${p ? p.t : 'EOF'}`);
    }
    this.pos++;
  }
  private parseName(): string {
    const p = this.peek();
    if (p && p.t === 'name') {
      this.pos++;
      return p.v!;
    }
    throw new Error('Expected name');
  }
  private parseType(): string {
    let type = this.parseName();
    if (this.peek() && this.peek().t === 'punct' && this.peek().v === '[') {
      this.consume('punct');
      type = type + '[]';
      if (this.peek() && this.peek().t === 'punct' && this.peek().v === '!') {
        this.consume('punct');
      }
    } else if (this.peek() && this.peek().t === 'punct' && this.peek().v === '!') {
      this.consume('punct');
    }
    return type;
  }
  private parseValue(): Value {
    const p = this.peek();
    if (!p) throw new Error('Unexpected EOF');
    switch (p.t) {
      case 'punct':
        if (p.v === '$') {
          this.consume('punct');
          return { kind: 'var', name: this.parseName() };
        } else if (p.v === '[') {
          this.consume('punct');
          const items: Value[] = [];
          while (this.peek() && this.peek().t !== 'punct' || (this.peek().v !== ']' && this.peek().v !== ',')) {
            if (this.peek().t === 'punct' && this.peek().v === ']') break;
            items.push(this.parseValue());
            if (this.peek() && this.peek().t === 'punct' && this.peek().v === ',') this.consume('punct');
          }
          this.consume('punct');
          return { kind: 'list', items };
        } else if (p.v === '{') {
          this.consume('punct');
          const fields: { name: string; value: Value }[] = [];
          while (this.peek() && !(this.peek().t === 'punct' && this.peek().v === '}')) {
            const name = this.parseName();
            this.consume('punct');
            fields.push({ name, value: this.parseValue() });
            if (this.peek() && this.peek().t === 'punct' && this.peek().v === ',') this.consume('punct');
          }
          this.consume('punct');
          return { kind: 'object', fields };
        }
        break;
      case 'string':
        this.consume('string');
        return { kind: 'lit', value: p.v };
      case 'int':
        this.consume('int');
        return { kind: 'lit', value: parseInt(p.v!, 10) };
      case 'float':
        this.consume('float');
        return { kind: 'lit', value: parseFloat(p.v!) };
      case 'name':
        const name = this.parseName();
        if (name === 'true') return { kind: 'lit', value: true };
        if (name === 'false') return { kind: 'lit', value: false };
        if (name === 'null') return { kind: 'lit', value: null };
        return { kind: 'lit', value: name };
    }
    throw new Error('Unexpected token for value');
  }
  private parseVariableDef(): { name: string; def: Value | null } {
    const name = this.parseName();
    this.consume('punct');
    const type = this.parseType();
    let def: Value | null = null;
    if (this.peek() && this.peek().t === 'punct' && this.peek().v === '=') {
      this.consume('punct');
      def = this.parseValue();
    }
    return { name, def };
  }
  private parseDirectives(): { name: string; args: { name: string; value: Value }[] }[] {
    const dirs: { name: string; args: { name: string; value: Value }[] }[] = [];
    while (this.peek() && this.peek().t === 'punct' && this.peek().v === '@') {
      this.consume('punct');
      const name = this.parseName();
      let args: { name: string; value: Value }[] = [];
      if (this.peek() && this.peek().t === 'punct' && this.peek().v === '(') {
        this.consume('punct');
        while (this.peek() && !(this.peek().t === 'punct' && this.peek().v === ')')) {
          const argName = this.parseName();
          this.consume('punct');
          args.push({ name: argName, value: this.parseValue() });
          if (this.peek() && this.peek().t === 'punct' && this.peek().v === ',') this.consume('punct');
        }
        this.consume('punct');
      }
      dirs.push({ name, args });
    }
    return dirs;
  }
  private parseSelectionSet(): Selection[] {
    const selections: Selection[] = [];
    this.consume('punct');
    while (this.peek() && !(this.peek().t === 'punct' && this.peek().v === '}')) {
      const p = this.peek();
      if (p.t === 'punct' && p.v === '...') {
        this.consume('punct');
        if (this.peek() && this.peek().t === 'punct' && this.peek().v === '{') {
          this.consume('punct');
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.parseName();
          selections.push({ kind: 'spread', name });
        }
      } else if (p.t === 'name') {
        const alias = this.peek(1) && this.peek(1).t === 'punct' && this.peek(1).v === ':' ? this.parseName() : null;
        const name = this.parseName();
        let args: { name: string; value: Value }[] = [];
        if (this.peek() && this.peek().t === 'punct' && this.peek().v === '(') {
          this.consume('punct');
          while (this.peek() && !(this.peek().t === 'punct' && this.peek().v === ')')) {
            const argName = this.parseName();
            this.consume('punct');
            args.push({ name: argName, value: this.parseValue() });
            if (this.peek() && this.peek().t === 'punct' && this.peek().v === ',') this.consume('punct');
          }
          this.consume('punct');
        }
        const directives = this.parseDirectives();
        let selectionSet: Selection[] | null = null;
        if (this.peek() && this.peek().t === 'punct' && this.peek().v === '{') {
          selectionSet = this.parseSelectionSet();
        }
        selections.push({
          kind: 'field',
          alias,
          name,
          args,
          directives,
          selectionSet
        });
      } else {
        throw new Error('Unexpected token in selection');
      }
    }
    this.consume('punct');
    return selections;
  }
  private parseOperation(): Operation {
    let type = 'query';
    if (this.peek() && this.peek().t === 'name') {
      const tname = this.parseName();
      if (['query', 'mutation', 'subscription'].includes(tname)) type = tname as any;
    }
    let name: string | null = null;
    if (this.peek() && this.peek().t === 'name') name = this.parseName();
    let varDefs: { name: string; def: Value | null }[] = [];
    if (this.peek() && this.peek().t === 'punct' && this.peek().v === '(') {
      this.consume('punct');
      while (this.peek() && !(this.peek().t === 'punct' && this.peek().v === ')')) {
        varDefs.push(this.parseVariableDef());
        if (this.peek() && this.peek().t === 'punct' && this.peek().v === ',') this.consume('punct');
      }
      this.consume('punct');
    }
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { type, name, varDefs, selectionSet };
  }
  private parseFragment(): { name: string; typeCondition: string; selectionSet: Selection[] } {
    this.consume('name');
    const name = this.parseName();
    this.consume('punct');
    const typeCondition = this.parseType();
    const selectionSet = this.parseSelectionSet();
    return { name, typeCondition, selectionSet };
  }
  parseDocument(src: string): GqlDoc {
    const tokens = tokenize(src);
    this.tokens = tokens;
    this.pos = 0;
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const p = this.peek();
      if (!p) break;
      if (p.t === 'name') {
        if (p.v === 'fragment') {
          const frag = this.parseFragment();
          fragments.set(frag.name, { typeCondition: frag.typeCondition, selectionSet: frag.selectionSet });
        } else if (['query', 'mutation', 'subscription'].includes(p.v ?? '')) {
          operations.push(this.parseOperation());
        } else {
          throw new Error(`Unexpected keyword ${p.v}`);
        }
      } else if (p.t === 'punct' && p.v === '{') {
        const op = this.parseOperation();
        operations.push(op);
      } else {
        throw new Error('Unexpected token in document');
      }
    }
    return { operations, fragments };
  }
}
export function parseDocument(src: string): GqlDoc {
  return new Parser([]).parseDocument(src);
}
export interface GqlObj { __t: string; v: any };
export function O(type: string, v: any): GqlObj { return { __t: type, v }; }

export type Resolver = (src: any, args: Record<string, any>, ctx: Ctx) => any;
export interface Ctx { store: any; vars: Record<string, any>; fragments: Map<string, any>; errors: any[] };

export const TYPES: Record<string, Record<string, Resolver>> = {};

export function valueFromAST(val: Value, vars: Record<string, any>): any {
  if (!val) return undefined;
  if (val.kind === 'var') return vars[val.name];
  if (val.kind === 'lit') return val.value;
  if (val.kind === 'list') return val.items.map((i: any) => valueFromAST(i, vars));
  if (val.kind === 'object') {
    const obj: any = {};
    for (const f of val.fields) {
      obj[f.name] = valueFromAST(f.value, vars);
    }
    return obj;
  }
  return undefined;
}

export function argsOf(sel: FieldSel, ctx: Ctx): Record<string, any> {
  const res: any = {};
  for (const a of sel.args) {
    res[a.name] = valueFromAST(a.value, ctx.vars);
  }
  return res;
}

export function skipped(sel: FieldSel, ctx: Ctx): boolean {
  for (const d of sel.directives) {
    if (d.name === 'skip') {
      const cond = valueFromAST(d.args[0]?.value, ctx.vars);
      if (cond === true) return true;
    } else if (d.name === 'include') {
      const cond = valueFromAST(d.args[0]?.value, ctx.vars);
      if (cond === false) return true;
    }
  }
  return false;
}

export function execSet(ctx: Ctx, typeName: string, src: any, sels: Selection[], path: (string | number)[]): Record<string, any> {
  const out: any = {};
  for (const sel of sels) {
    if (skipped(sel, ctx)) continue;
    const key = sel.alias ?? sel.name;
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) {
        const condOk = !frag.typeCondition || frag.typeCondition === typeName || ['Node', 'Actor', 'RepositoryOwner', 'UniformResourceLocatable', 'Issue', 'PullRequest'].includes(typeName);
        if (condOk) {
          Object.assign(out, execSet(ctx, frag.typeCondition || typeName, src, frag.selectionSet, path));
        }
      }
      continue;
    }
    if (sel.kind === 'inline') {
      const condOk = !sel.typeCondition || sel.typeCondition === typeName || ['Node', 'Actor', 'RepositoryOwner', 'UniformResourceLocatable', 'Issue', 'PullRequest'].includes(typeName);
      if (condOk) {
        Object.assign(out, execSet(ctx, sel.typeCondition || typeName, src, sel.selectionSet, path));
      }
      continue;
    }
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = TYPES[typeName]?.[sel.name];
    if (!resolver) {
      ctx.errors.push({ message: "Field '" + sel.name + "' doesn't exist on type '" + typeName + "'", type: 'FIELD_ERROR', path: [...path, key] });
      out[key] = null;
      continue;
    }
    const args = argsOf(sel, ctx);
    let raw = resolver(src, args, ctx);
    out[key] = completeValue(ctx, raw, sel, [...path, key]);
  }
  return out;
}

function completeValue(ctx: Ctx, raw: any, sel: FieldSel, path: (string | number)[]): any {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((r: any, i: number) => completeValue(ctx, r, sel, [...path, i]));
  if (raw.__t !== undefined) {
    if (sel.selectionSet) {
      return execSet(ctx, raw.__t, raw.v, sel.selectionSet, path);
    }
    return raw.v;
  }
  return raw;
}

export function executeOperation(ctx: Ctx, op: Operation, doc: GqlDoc): Record<string, any> {
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  return execSet(ctx, rootType, null, op.selectionSet, []);
}

export function encodeCursor(i: number): string {
  return Buffer.from('cursor:' + i, 'utf8').toString('base64');
}

export function decodeCursor(s: any): number {
  if (typeof s !== 'string') return -1;
  try {
    const raw = Buffer.from(s, 'base64').toString('utf8');
    if (raw.startsWith('cursor:')) return parseInt(raw.slice(7), 10);
  } catch {}
  return -1;
}

export function connPayload(items: any[], args: Record<string, any>): { totalCount: number; pageInfo: any; edges: any[]; nodes: any[] } {
  const total = items.length;
  let start = 0;
  let end = total;
  const after = args.after;
  if (after != null) {
    const dc = decodeCursor(after);
    start = (dc > 0 ? dc : 0) + 1;
  }
  const before = args.before;
  if (before != null) {
    const dc = decodeCursor(before);
    end = Math.max(start, dc > 0 ? dc : total);
  }
  const sliceStart = Math.max(0, start);
  const sliceEnd = Math.min(total, end);
  const kept: { item: any; idx: number }[] = [];
  if (args.first != null) {
    for (let i = 0; i < items.length; i++) {
      if (kept.length >= args.first) break;
      kept.push({ item: items[i], idx: i });
    }
  } else if (args.last != null) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (kept.length >= args.last) break;
      kept.push({ item: items[i], idx: i });
    }
    kept.reverse();
  } else {
    for (let i = 0; i < items.length; i++) {
      kept.push({ item: items[i], idx: i });
    }
  }
  const pageInfo: any = {
    hasNextPage: kept.length > 0 && kept[kept.length - 1].idx + 1 < end,
    hasPreviousPage: kept.length > 0 && kept[0].idx > 0,
    startCursor: kept.length > 0 ? encodeCursor(kept[0].idx) : null,
    endCursor: kept.length > 0 ? encodeCursor(kept[kept.length - 1].idx) : null
  };
  const edges = kept.map(e => O('Edge', { cursor: encodeCursor(e.idx), node: e.item }));
  return {
    totalCount: total,
    pageInfo,
    edges,
    nodes: kept.map(e => e.item)
  };
}

export function registerConn(connName: string, nodeType: string): void {
  TYPES[connName] = {
    totalCount: (o) => o.totalCount,
    pageInfo: (o) => O('PageInfo', o.pageInfo),
    edges: (o) => o.edges.map((e: any) => O(connName.replace('Connection', 'Edge'), e)),
    nodes: (o) => o.nodes
  };
  TYPES[connName.replace('Connection', 'Edge')] = {
    cursor: (e) => e.cursor,
    node: (e) => e.node
  };
}

TYPES.PageInfo = {
  hasNextPage: (p) => p.hasNextPage,
  hasPreviousPage: (p) => p.hasPreviousPage,
  startCursor: (p) => p.startCursor,
  endCursor: (p) => p.endCursor
};
import { nodeId, parseNodeId, nowIso } from './store.ts'; import { getObject, putObject, parseCommit, parseTree, parseTag, formatTree, formatCommit, treeDiff, diffLineCounts, isAncestor } from './gitcore.ts';
export function userObj(store: any): any {
  return O('User', store.viewer());
}
export function repoObj(repo: any): any {
  return O('Repository', repo);
}
export function issueObj(repo: any, rec: any): any {
  return O('Issue', { repo, rec });
}
export function pullObj(repo: any, rec: any): any {
  return O('PullRequest', { repo, rec });
}
export function commentObj(repo: any, rec: any, c: any): any {
  return O('IssueComment', { repo, rec, c });
}
export function labelObj(l: any): any {
  return O('Label', l);
}
export function commitObj(repo: any, sha: string): any {
  return O('Commit', { repo, sha });
}
export function refObj(repo: any, full: string, sha: string | null, prefix: string): any {
  return O('Ref', { repo, full, sha, prefix, name: full.slice(prefix.length) });
}
export function emptyConn(): any {
  return {
    totalCount: 0,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null
    },
    edges: [],
    nodes: []
  };
}
export function ownerLogin(store: any): string {
  return store.viewerLogin() ?? 'viewer';
}
export function findRepoByDbId(store: any, id: number): any | null {
  return store.listRepos().find((r: any) => r.id === id) || null;
}
export function findRecordByDbId(store: any, id: number): { repo: any, rec: any } | null {
  for (const repo of store.listRepos()) {
    for (const rec of (repo.issues?.values?.() || [])) {
      if (rec.id === id) {
        return { repo, rec };
      }
    }
  }
  return null;
}
export function findCommentByDbId(store: any, id: number): { repo: any, rec: any, c: any } | null {
  for (const repo of store.listRepos()) {
    for (const rec of (repo.issues?.values?.() || [])) {
      for (const c of (rec.comments?.values?.() || [])) {
        if (c.id === id) {
          return { repo, rec, c };
        }
      }
    }
  }
  return null;
}
TYPES.RateLimit = {
  limit: () => 5000,
  cost: () => 1,
  remaining: () => 4999,
  used: () => 1,
  resetAt: () => '2030-01-01T00:00:00Z',
  nodeCount: () => 0
};
TYPES.User = {
  login: (u: any) => u.login,
  id: (u: any) => nodeId('User', u.id),
  databaseId: (u: any) => u.id,
  name: (u: any) => u.name,
  email: (u: any) => u.email,
  url: () => '',
  avatarUrl: () => '',
  isViewer: () => true,
  createdAt: () => '2024-01-01T00:00:00Z',
  updatedAt: () => '2024-01-01T00:00:00Z',
  repositories: (u: any, a: any, ctx: any) => O('RepositoryConnection', connPayload(ctx.store.listRepos().map((r: any) => repoObj(r)), a))
};
TYPES.Query = {
  viewer: (s: any, a: any, ctx: any) => userObj(ctx.store),
  repository: (s: any, a: any, ctx: any) => {
    const vl = ctx.store.viewerLogin();
    if (vl && a.owner && a.owner !== vl) return null;
    const repo = ctx.store.getRepoByName(a.name);
    if (!repo) return null;
    if (!vl && a.owner) ctx.store.adoptViewer(a.owner);
    return repoObj(repo);
  },
  node: (s: any, a: any, ctx: any) => {
    const p = parseNodeId(String(a.id ?? ''));
    if (!p) return null;
    if (p.kind === 'User') return p.id === 1000 ? userObj(ctx.store) : null;
    if (p.kind === 'Repository') {
      const r = findRepoByDbId(ctx.store, p.id);
      return r ? repoObj(r) : null;
    }
    if (p.kind === 'Issue' || p.kind === 'PullRequest') {
      const f = findRecordByDbId(ctx.store, p.id);
      if (!f) return null;
      return f.rec.kind === 'pull' ? pullObj(f.repo, f.rec) : issueObj(f.repo, f.rec);
    }
    if (p.kind === 'IssueComment') {
      const f = findCommentByDbId(ctx.store, p.id);
      return f ? commentObj(f.repo, f.rec, f.c) : null;
    }
    if (p.kind === 'Label') {
      for (const r of ctx.store.listRepos()) {
        for (const l of r.labels.values()) {
          if (l.id === p.id) return labelObj(l);
        }
      }
      return null;
    }
    return null;
  },
  rateLimit: () => O('RateLimit', {})
};
export function sortByOrder(recs: any[], a: any): any[] {
  if (a.orderBy && a.orderBy.field === 'CREATED_AT') {
    const asc = a.orderBy.direction === 'ASC';
    return [...recs].sort((x, y) => {
      const dx = new Date(x.createdAt || 0).getTime();
      const dy = new Date(y.createdAt || 0).getTime();
      return asc ? dx - dy : dy - dx;
    });
  }
  return recs;
}
TYPES.Repository = {
  id: (r) => nodeId('Repository', r.id),
  databaseId: (r) => r.id,
  name: (r) => r.name,
  nameWithOwner: (r, a, ctx) => ownerLogin(ctx.store) + '/' + r.name,
  owner: (r, a, ctx) => userObj(ctx.store),
  description: (r) => r.description,
  isPrivate: (r) => r.private,
  url: () => '',
  homepageUrl: () => null,
  createdAt: (r) => r.createdAt,
  updatedAt: (r) => r.updatedAt,
  pushedAt: (r) => r.pushedAt,
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  hasProjectsEnabled: () => true,
  hasWikiEnabled: () => true,
  isArchived: () => false,
  isDisabled: () => false,
  isFork: () => false,
  isMirror: () => false,
  isTemplate: () => false,
  forkCount: () => 0,
  stargazerCount: () => 0,
  diskUsage: () => 0,
  primaryLanguage: () => null,
  licenseInfo: () => null,
  mergeCommitAllowed: () => true,
  squashMergeAllowed: () => true,
  rebaseMergeAllowed: () => true,
  deleteBranchOnMerge: () => false,
  autoMergeAllowed: () => false,
  viewerCanAdminister: () => true,
  viewerDefaultMergeMethod: () => 'SQUASH',
  defaultBranchRef: (r) => refObj(r, 'refs/heads/' + r.defaultBranch, r.refs.get('refs/heads/' + r.defaultBranch) ?? null, 'refs/heads/'),
  watchers: () => O('UserConnection', emptyConn()),
  issues: (r, a) => {
    let recs = Array.from(r.issues.values()).filter((x) => x.kind === 'issue');
    if (a.states) recs = recs.filter((x) => a.states.includes(x.state === 'open' ? 'OPEN' : 'CLOSED'));
    if (a.labels) recs = recs.filter((x) => a.labels.some((n) => x.labels.includes(n)));
    recs = sortByOrder(recs, a);
    return O('IssueConnection', connPayload(recs.map((x) => issueObj(r, x)), a));
  },
  issue: (r, a) => {
    const rec = r.issues.get(a.number);
    return rec && rec.kind === 'issue' ? issueObj(r, rec) : null;
  },
  issueOrPullRequest: (r, a) => {
    const rec = r.issues.get(a.number);
    if (!rec) return null;
    return rec.kind === 'pull' ? pullObj(r, rec) : issueObj(r, rec);
  },
  pullRequests: (r, a) => {
    let recs = Array.from(r.issues.values()).filter((x) => x.kind === 'pull');
    if (a.states) recs = recs.filter((x) => a.states.some((s) => (s === 'OPEN' && x.state === 'open') || (s === 'MERGED' && x.merged) || (s === 'CLOSED' && x.state === 'closed' && !x.merged)));
    recs = sortByOrder(recs, a);
    return O('PullRequestConnection', connPayload(recs.map((x) => pullObj(r, x)), a));
  },
  pullRequest: (r, a) => {
    const rec = r.issues.get(a.number);
    return rec && rec.kind === 'pull' ? pullObj(r, rec) : null;
  },
  labels: (r, a) => O('LabelConnection', connPayload(Array.from(r.labels.values()).sort((x, y) => x.name < y.name ? -1 : 1).map((l) => labelObj(l)), a)),
  label: (r, a) => {
    const l = r.labels.get(a.name);
    return l ? labelObj(l) : null;
  },
  refs: (r, a) => {
    const prefix = a.refPrefix ?? 'refs/';
    const names = Array.from(r.refs.keys()).filter((n) => n.startsWith(prefix)).sort();
    return O('RefConnection', connPayload(names.map((n) => refObj(r, n, r.refs.get(n) ?? null, prefix)), a));
  },
  ref: (r, a) => {
    const prefix = a.qualifiedName.startsWith('refs/heads/') ? 'refs/heads/' : 'refs/';
    const sha = r.refs.get(a.qualifiedName);
    return sha !== undefined ? refObj(r, a.qualifiedName, sha, prefix) : null;
  },
  object: (r, a) => {
    const oid = a.oid ?? (typeof a.expression === 'string' && /^[0-9a-f]{40}$/.test(a.expression) ? a.expression : null);
    if (oid) {
      const obj = getObject(r, oid);
      if (!obj) return null;
      if (obj.type === 'commit') return commitObj(r, oid);
      if (obj.type === 'blob') return O('Blob', { repo: r, sha: oid });
      if (obj.type === 'tree') return O('Tree', { repo: r, sha: oid });
      return null;
    }
    if (typeof a.expression === 'string' && a.expression.length > 0) {
      const expr = a.expression;
      const colon = expr.indexOf(':');
      const rev = colon >= 0 ? expr.slice(0, colon) : expr;
      const path = colon >= 0 ? expr.slice(colon + 1) : '';
      let sha = r.refs.get('refs/heads/' + rev) ?? r.refs.get('refs/tags/' + rev) ?? (/^[0-9a-f]{40}$/.test(rev) ? rev : null);
      if (!sha) return null;
      let obj = getObject(r, sha);
      if (!obj) return null;
      if (obj.type === 'tag') {
        sha = parseTag(obj.data).object;
        obj = getObject(r, sha);
        if (!obj) return null;
      }
      if (obj.type !== 'commit') return null;
      if (path === '') return commitObj(r, sha);
      const flat = flattenTreeG(r, parseCommit(obj.data).tree);
      const target = flat.get(path);
      if (!target) return null;
      const tobj = getObject(r, target);
      if (!tobj) return null;
      if (tobj.type === 'blob') return O('Blob', { repo: r, sha: target });
      if (tobj.type === 'tree') return O('Tree', { repo: r, sha: target });
      return null;
    }
    return null;
  },
};
registerConn('RepositoryConnection', 'Repository');
registerConn('UserConnection', 'User');
registerConn('IssueConnection', 'Issue');
registerConn('PullRequestConnection', 'PullRequest');
registerConn('LabelConnection', 'Label');
registerConn('RefConnection', 'Ref');
// Merge helpers (export all)
export function flattenTreeG(repo: any, treeSha: string): Map<string, string> {
  const treeMap = new Map<string, string>();
  const walk = (sha: string, prefix: string = '') => {
    const tree = getObject(repo, sha);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const fullPath = prefix + (prefix ? '/' : '') + entry.name;
      if (entry.mode === '40000') {
        walk(entry.sha, fullPath);
      } else {
        treeMap.set(fullPath, entry.sha);
      }
    }
  };
  walk(treeSha);
  return treeMap;
}

export function buildTreeG(repo: any, flat: Map<string, string>): string {
  type Node = { dirs: Map<string, Node>; files: Map<string, string> };
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, sha] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: new Map() });
      node = node.dirs.get(parts[i])!;
    }
    node.files.set(parts[parts.length - 1], sha);
  }
  const writeNode = (node: Node): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, sub] of node.dirs) {
      entries.push({ mode: '40000', name, sha: writeNode(sub) });
    }
    for (const [name, sha] of node.files) {
      entries.push({ mode: '100644', name, sha });
    }
    entries.sort((a, b) => (a.name + (a.mode === '40000' ? '/' : '')).localeCompare(b.name + (b.mode === '40000' ? '/' : '')));
    return putObject(repo, 'tree', formatTree(entries));
  };
  return writeNode(root);
}

export function treeOfCommitG(repo: any, sha: string): string | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

export function mergeBaseG(repo: any, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  let queue: string[] = [a];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (ancestors.has(cur)) continue;
    ancestors.add(cur);
    const obj = getObject(repo, cur);
    if (obj && obj.type === 'commit') {
      queue.push(...parseCommit(obj.data).parents);
    }
  }
  queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancestors.has(cur)) return cur;
    const obj = getObject(repo, cur);
    if (obj && obj.type === 'commit') {
      queue.push(...parseCommit(obj.data).parents);
    }
  }
  return null;
}

export function computeMergeG(repo: any, baseTip: string, headTip: string): { conflict: boolean; treeSha?: string } {
  const mb = mergeBaseG(repo, baseTip, headTip);
  if (!mb) return { conflict: true };
  const mbTree = treeOfCommitG(repo, mb);
  const baseTree = treeOfCommitG(repo, baseTip);
  const headTree = treeOfCommitG(repo, headTip);
  if (!mbTree || !baseTree || !headTree) return { conflict: true };
  const mbMap = flattenTreeG(repo, mbTree);
  const baseMap = flattenTreeG(repo, baseTree);
  const headMap = flattenTreeG(repo, headTree);
  const mergedMap = new Map<string, string>();
  let conflict = false;
  const allPaths = new Set([...mbMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const mbV = mbMap.get(path) || '';
    const baseV = baseMap.get(path) || '';
    const headV = headMap.get(path) || '';
    let chosenV: string | undefined;
    if (headV === mbV) {
      chosenV = baseV;
    } else if (baseV === mbV) {
      chosenV = headV;
    } else if (baseV === headV) {
      chosenV = baseV;
    } else {
      conflict = true;
      break;
    }
    mergedMap.set(path, chosenV!);
  }
  if (conflict) return { conflict: true };
  return { conflict: false, treeSha: buildTreeG(repo, mergedMap) };
}

export function doMergeG(store: any, repo: any, rec: any, method: string, headline?: string, bodyText?: string): { sha: string } | { conflict: true } {
  const baseRef = rec.baseRef;
  const headRef = rec.headRef;
  const baseTip = repo.refs.get('refs/heads/' + baseRef) ?? repo.refs.get(baseRef) ?? rec.baseSha;
  const headTip = repo.refs.get('refs/heads/' + headRef) ?? repo.refs.get(headRef) ?? rec.headSha;
  const mergeRes = computeMergeG(repo, baseTip, headTip);
  if (mergeRes.conflict) return { conflict: true };
  const treeSha = mergeRes.treeSha!;
  const nowIso = new Date().toISOString();
  const unixNow = Math.floor(Date.parse(nowIso) / 1000);
  const ident = `${store.viewer().name} <${store.viewer().email}> ${unixNow} +0000`;
  let parents: string[];
  let message: string;
  if (method === 'MERGE') {
    parents = [baseTip, headTip];
    message = headline ?? `Merge pull request #${rec.number}`;
  } else {
    parents = [baseTip];
    message = (headline ?? `${rec.title} (#${rec.number})`) + (bodyText ? '\n\n' + bodyText : '');
  }
  const commitSha = putObject(repo, 'commit', formatCommit({
    tree: treeSha,
    parents,
    message,
    author: ident,
    committer: ident
  }));
  repo.refs.set('refs/heads/' + baseRef, commitSha);
  rec.merged = true;
  rec.mergedAt = nowIso;
  rec.mergeCommitSha = commitSha;
  rec.state = 'closed';
  rec.closedAt = nowIso;
  rec.updatedAt = nowIso;
  return { sha: commitSha };
}

export function filesOf(repo: any, rec: any): { path: string; additions: number; deletions: number; changeType: string }[] {
  const baseTip = repo.refs.get(rec.baseRef) || rec.baseSha;
  const headTip = repo.refs.get(rec.headRef) || rec.headSha;
  const mb = mergeBaseG(repo, baseTip, headTip);
  const mbTree = treeOfCommitG(repo, mb);
  const headTree = treeOfCommitG(repo, headTip);
  if (!mbTree || !headTree) return [];
  const mbMap = flattenTreeG(repo, mbTree);
  const headMap = flattenTreeG(repo, headTree);
  const files: any[] = [];
  const allPaths = new Set([...mbMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const mbSha = mbMap.get(path);
    const headSha = headMap.get(path);
    const changeType = headSha && !mbSha ? 'ADDED' : mbSha && !headSha ? 'DELETED' : 'MODIFIED';
    const additions = headSha && !mbSha ? 1 : 0;
    const deletions = mbSha && !headSha ? 1 : 0;
    const diffLineCounts = (sha: string): number => {
      if (!sha) return 0;
      const blob = repo.objects.get(sha);
      if (!blob) return 0;
      const content = blob.content || (blob.buffer ? String.fromCharCode(...blob.buffer) : '');
      return (content.match(/\n/g) || []).length + 1;
    };
    const addLines = diffLineCounts(headSha);
    const delLines = diffLineCounts(mbSha);
    files.push({ path, additions: addLines, deletions: delLines, changeType });
  }
  return files;
}

// Shared issue-field resolvers
export function issueFields(kind: 'Issue' | 'PullRequest'): Record<string, Resolver> {
  return {
    id: (o) => nodeId(kind, o.rec.id),
    databaseId: (o) => o.rec.id,
    number: (o) => o.rec.number,
    title: (o) => o.rec.title,
    body: (o) => o.rec.body,
    bodyText: (o) => o.rec.body,
    bodyHTML: (o) => o.rec.body,
    url: () => '',
    resourcePath: () => '',
    state: (o) => o.rec.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: (o) => o.rec.state === 'closed' ? 'COMPLETED' : null,
    closed: (o) => o.rec.state === 'closed',
    closedAt: (o) => o.rec.closedAt,
    createdAt: (o) => o.rec.createdAt,
    updatedAt: (o) => o.rec.updatedAt,
    author: (o, a, ctx) => userObj(ctx.store),
    editor: () => null,
    labels: (o, a) => O('LabelConnection', connPayload(o.rec.labels.map((n) => o.repo.labels.get(n)).filter(Boolean).map((l) => labelObj(l)), a)),
    comments: (o, a) => O('IssueCommentConnection', connPayload(o.rec.comments.map((c) => commentObj(o.repo, o.rec, c)), a)),
    repository: (o) => repoObj(o.repo),
    participants: (o, a, ctx) => O('UserConnection', connPayload([userObj(ctx.store)], a)),
    assignees: () => O('UserConnection', emptyConn()),
    milestone: () => null,
    reactionGroups: () => [],
    viewerDidAuthor: () => true,
    viewerCanUpdate: () => true,
    viewerCanReact: () => false,
    viewerCanDelete: () => false,
    viewerCanClose: () => true,
    viewerCanReopen: () => true,
    viewerCanComment: () => true,
    locked: () => false,
    activeLockReason: () => null,
    isPinned: () => false,
    createdViaEmail: () => false,
    publishedAt: (o) => o.rec.createdAt,
    lastEditedAt: () => null,
    subIssuesSummary: () => null,
    issueType: () => null,
    parent: () => null,
  };
}

TYPES.Issue = issueFields('Issue');
TYPES.PullRequest = { ...issueFields('PullRequest'), state: (o) => o.rec.merged ? 'MERGED' : (o.rec.state === 'open' ? 'OPEN' : 'CLOSED'), merged: (o) => o.rec.merged, mergedAt: (o) => o.rec.mergedAt, mergedBy: (o, a, ctx) => o.rec.merged ? userObj(ctx.store) : null, headRefName: (o) => o.rec.headRef, baseRefName: (o) => o.rec.baseRef, headRefOid: (o) => o.repo.refs.get('refs/heads/' + o.rec.headRef) ?? o.rec.headSha, baseRefOid: (o) => o.repo.refs.get('refs/heads/' + o.rec.baseRef) ?? o.rec.baseSha, headRef: (o) => { const sha = o.repo.refs.get('refs/heads/' + o.rec.headRef); return sha ? refObj(o.repo, 'refs/heads/' + o.rec.headRef, sha, 'refs/heads/') : null; }, baseRef: (o) => { const sha = o.repo.refs.get('refs/heads/' + o.rec.baseRef); return sha ? refObj(o.repo, 'refs/heads/' + o.rec.baseRef, sha, 'refs/heads/') : null; }, isDraft: () => false, mergeCommit: (o) => o.rec.mergeCommitSha ? commitObj(o.repo, o.rec.mergeCommitSha) : null, potentialMergeCommit: () => null, mergeable: (o) => { if (o.rec.merged) return 'MERGEABLE'; const bt = o.repo.refs.get('refs/heads/' + o.rec.baseRef); const ht = o.repo.refs.get('refs/heads/' + o.rec.headRef); if (!bt || !ht) return 'UNKNOWN'; return computeMergeG(o.repo, bt, ht).conflict ? 'CONFLICTING' : 'MERGEABLE'; }, mergeStateStatus: (o, a, ctx) => (TYPES.PullRequest.mergeable as any)(o, a, ctx) === 'CONFLICTING' ? 'DIRTY' : 'CLEAN', additions: (o) => filesOf(o.repo, o.rec).reduce((s, f) => s + f.additions, 0), deletions: (o) => filesOf(o.repo, o.rec).reduce((s, f) => s + f.deletions, 0), changedFiles: (o) => filesOf(o.repo, o.rec).length, files: (o, a) => O('PullRequestChangedFileConnection', connPayload(filesOf(o.repo, o.rec).map((f) => O('ChangedFile', f)), a)), commits: (o, a) => { const bt = o.repo.refs.get('refs/heads/' + o.rec.baseRef); const ht = o.repo.refs.get('refs/heads/' + o.rec.headRef); if (!bt || !ht) return O('PullRequestCommitConnection', emptyConn()); const nodes = []; const visited = new Set(); const queue = [ht]; visited.add(ht); while (queue.length > 0) { const cur = queue.shift(); if (cur === bt) break; nodes.push(cur); const obj = getObject(o.repo, cur); if (!obj) continue; for (const p of parseCommit(obj.data).parents) { if (!visited.has(p)) { visited.add(p); queue.push(p); } } } return O('PullRequestCommitConnection', connPayload(nodes.map((sha) => ({ commit: commitObj(o.repo, sha) })), a)); }, reviews: () => O('PullRequestReviewConnection', emptyConn()), latestReviews: () => O('PullRequestReviewConnection', emptyConn()), reviewThreads: () => O('PullRequestReviewThreadConnection', emptyConn()), closingIssuesReferences: () => O('IssueConnection', emptyConn()), isCrossRepository: () => false, maintainerCanModify: () => false, autoMergeRequest: () => null, statusCheckRollup: () => null, baseRefRepository: (o) => repoObj(o.repo), headRefRepository: (o) => repoObj(o.repo), permalink: () => '' };
TYPES.ChangedFile = { path: (f) => f.path, additions: (f) => f.additions, deletions: (f) => f.deletions, changeType: (f) => f.changeType, viewerViewedState: () => 'UNVIEWED' };
TYPES.PullRequestCommit = { commit: (o) => o.commit };
TYPES.IssueComment = { id: (o) => nodeId('IssueComment', o.c.id), databaseId: (o) => o.c.id, body: (o) => o.c.body, bodyText: (o) => o.c.body, url: () => '', createdAt: (o) => o.c.createdAt, updatedAt: (o) => o.c.updatedAt, author: (o, a, ctx) => userObj(ctx.store), editor: () => null, issue: (o) => issueObj(o.repo, o.rec), pullRequest: (o) => o.rec.kind === 'pull' ? pullObj(o.repo, o.rec) : null, repository: (o) => repoObj(o.repo), viewerDidAuthor: () => true, viewerCanUpdate: () => true, viewerCanDelete: () => false, viewerCanReact: () => false, reactionGroups: () => [], lastEditedAt: () => null, publishedAt: (o) => o.c.createdAt, createdViaEmail: () => false, isMinimized: () => false, minimizedReason: () => null };
TYPES.Label = { id: (l) => nodeId('Label', l.id), name: (l) => l.name, color: (l) => l.color, description: (l) => l.description, isDefault: () => true, url: () => '', createdAt: () => '2024-01-01T00:00:00Z', updatedAt: () => '2024-01-01T00:00:00Z' };
TYPES.Ref = { name: (o) => o.name, prefix: (o) => o.prefix, target: (o) => o.sha ? commitObj(o.repo, o.sha) : null, repository: (o) => repoObj(o.repo), associatedPullRequests: () => O('PullRequestConnection', emptyConn()) };
function parseIdentG(ident: string): { name: string; email: string; ts: number } {
  const m = String(ident ?? '').match(/^(.+?)\s+<([^>]+)>\s+(\d+)\s+(.+)$/);
  if (!m) return { name: '', email: '', ts: 0 };
  return { name: m[1].trim(), email: m[2], ts: Number(m[3]) };
}
TYPES.Commit = { oid: (o) => o.sha, abbreviatedOid: (o) => o.sha.slice(0, 7), message: (o) => parseCommit(getObject(o.repo, o.sha).data).message, messageHeadline: (o) => parseCommit(getObject(o.repo, o.sha).data).message.split('\n')[0] || '', messageBody: (o) => { const m = parseCommit(getObject(o.repo, o.sha).data).message; const lines = m.split('\n'); return lines.length > 1 ? lines.slice(1).join('\n') : ''; }, committedDate: (o) => { const c = parseCommit(getObject(o.repo, o.sha).data); return new Date(parseIdentG(c.committer).ts * 1000).toISOString(); }, authoredDate: (o) => { const c = parseCommit(getObject(o.repo, o.sha).data); return new Date(parseIdentG(c.author).ts * 1000).toISOString(); }, author: (o) => O('GitActor', parseIdentG(parseCommit(getObject(o.repo, o.sha).data).author)), committer: (o) => O('GitActor', parseIdentG(parseCommit(getObject(o.repo, o.sha).data).committer)), tree: (o) => O('Tree', { repo: o.repo, sha: parseCommit(getObject(o.repo, o.sha).data).tree }), parents: (o, a) => O('CommitConnection', connPayload(parseCommit(getObject(o.repo, o.sha).data).parents.map((p) => commitObj(o.repo, p)), a)), history: (o, a) => { const nodes = []; const visited = new Set(); const queue = [o.sha]; visited.add(o.sha); while (queue.length > 0) { const cur = queue.shift(); nodes.push(cur); const obj = getObject(o.repo, cur); if (!obj) continue; for (const p of parseCommit(obj.data).parents) { if (!visited.has(p)) { visited.add(p); queue.push(p); } } } return O('CommitConnection', connPayload(nodes.map((n) => commitObj(o.repo, n)), a)); }, url: () => '', resourcePath: () => '', signature: () => null, additions: () => null, deletions: () => null, changedFilesIfAvailable: () => null, status: () => null, tarballUrl: () => '', zipballUrl: () => '', associatedPullRequests: () => O('PullRequestConnection', emptyConn()), comments: () => O('IssueCommentConnection', emptyConn()) };
TYPES.GitActor = { name: (x) => x.name, email: (x) => x.email, date: (x) => new Date(x.ts * 1000).toISOString(), user: (x, a, ctx) => x.email === ctx.store.viewer().email ? userObj(ctx.store) : null };
TYPES.Tree = { oid: (o) => o.sha, entries: (o) => parseTree(getObject(o.repo, o.sha)?.data ?? Buffer.alloc(0)).map((e) => O('TreeEntry', { repo: o.repo, entry: e })), repository: (o) => repoObj(o.repo) };
TYPES.TreeEntry = { name: (o) => o.entry.name, path: (o) => o.entry.name, type: (o) => o.entry.mode === '40000' ? 'tree' : 'blob', mode: (o) => parseInt(o.entry.mode, 8), extension: (o) => o.entry.name.includes('.') ? o.entry.name.slice(o.entry.name.lastIndexOf('.')) : '', object: (o) => O(o.entry.mode === '40000' ? 'Tree' : 'Blob', { repo: o.repo, sha: o.entry.sha }) };
TYPES.Blob = { oid: (o) => o.sha, byteSize: (o) => getObject(o.repo, o.sha)?.data.length ?? 0, text: (o) => (getObject(o.repo, o.sha)?.data ?? Buffer.alloc(0)).toString('utf8'), isBinary: () => false, isTruncated: () => false };
registerConn('IssueCommentConnection', 'IssueComment'); registerConn('CommitConnection', 'Commit'); registerConn('PullRequestChangedFileConnection', 'ChangedFile'); registerConn('PullRequestCommitConnection', 'PullRequestCommit'); registerConn('PullRequestReviewConnection', 'PullRequestReview'); registerConn('PullRequestReviewThreadConnection', 'PullRequestReviewThread')
TYPES.CreateIssuePayload = { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId };
TYPES.CloseIssuePayload = { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId };
TYPES.ReopenIssuePayload = { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId };
TYPES.AddCommentPayload = { commentEdge: (p) => O('IssueCommentEdge', p.commentEdge), subject: (p) => p.subject, clientMutationId: (p) => p.clientMutationId };
TYPES.CreatePullRequestPayload = { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId };
TYPES.MergePullRequestPayload = { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId };
const err = (ctx, message) => ctx.errors.push({ message, type: 'MUTATION_ERROR' });
const recordFromNode = (ctx, idStr) => { const p = parseNodeId(String(idStr ?? '')); if (!p) return null; return findRecordByDbId(ctx.store, p.id); };
TYPES.Mutation = {
  createIssue: (s, a, ctx) => { const input = a.input ?? {}; const p = parseNodeId(String(input.repositoryId ?? '')); const repo = p ? findRepoByDbId(ctx.store, p.id) : null; if (!repo || !input.title) { err(ctx, 'Could not create issue'); return O('CreateIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null }); } let labels: string[] = []; if (Array.isArray(input.labelIds)) { for (const lid of input.labelIds) { const lp = parseNodeId(String(lid)); if (lp) { for (const l of repo.labels.values()) { if (l.id === lp.id) labels.push(l.name); } } } } if (Array.isArray(input.labels)) labels = input.labels.filter((n) => repo.labels.has(n)); const rec = ctx.store.createIssue(repo, { title: input.title, body: input.body ?? '', labels }); return O('CreateIssuePayload', { issue: issueObj(repo, rec), clientMutationId: input.clientMutationId ?? null }); },
  closeIssue: (s, a, ctx) => { const input = a.input ?? {}; const f = recordFromNode(ctx, input.issueId); if (!f) { err(ctx, 'Issue not found'); return O('CloseIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null }); } f.rec.state = 'closed'; f.rec.closedAt = nowIso(); f.rec.updatedAt = f.rec.closedAt; return O('CloseIssuePayload', { issue: issueObj(f.repo, f.rec), clientMutationId: input.clientMutationId ?? null }); },
  reopenIssue: (s, a, ctx) => { const input = a.input ?? {}; const f = recordFromNode(ctx, input.issueId); if (!f) { err(ctx, 'Issue not found'); return O('ReopenIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null }); } f.rec.state = 'open'; f.rec.closedAt = null; f.rec.updatedAt = nowIso(); return O('ReopenIssuePayload', { issue: issueObj(f.repo, f.rec), clientMutationId: input.clientMutationId ?? null }); },
  addComment: (s, a, ctx) => { const input = a.input ?? {}; const f = recordFromNode(ctx, input.subjectId); if (!f || !input.body) { err(ctx, 'Could not add comment'); return O('AddCommentPayload', { commentEdge: null, subject: null, clientMutationId: input.clientMutationId ?? null }); } const c = ctx.store.addComment(f.repo, f.rec.number, input.body); const node = commentObj(f.repo, f.rec, c); return O('AddCommentPayload', { commentEdge: { node, cursor: encodeCursor(f.rec.comments.length - 1) }, subject: f.rec.kind === 'pull' ? pullObj(f.repo, f.rec) : issueObj(f.repo, f.rec), clientMutationId: input.clientMutationId ?? null }); },
  createPullRequest: (s, a, ctx) => { const input = a.input ?? {}; const p = parseNodeId(String(input.repositoryId ?? '')); const repo = p ? findRepoByDbId(ctx.store, p.id) : null; const fail = (msg) => { err(ctx, msg); return O('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null }); }; if (!repo) return fail('Repository not found'); const strip = (r) => String(r ?? '').includes(':') ? String(r).split(':').pop() : String(r ?? ''); const head = strip(input.headRefName); const base = strip(input.baseRefName ?? repo.defaultBranch); const headTip = repo.refs.get('refs/heads/' + head); const baseTip = repo.refs.get('refs/heads/' + base); if (!headTip || !baseTip) return fail('Head or base branch not found'); if (headTip === baseTip || isAncestor(repo, headTip, baseTip)) return fail('No commits between base and head'); if (!input.title) return fail('Title is required'); const rec = ctx.store.createPull(repo, { title: input.title, body: input.body ?? '', headRef: head, baseRef: base, headSha: headTip, baseSha: baseTip }); return O('CreatePullRequestPayload', { pullRequest: pullObj(repo, rec), clientMutationId: input.clientMutationId ?? null }); },
  mergePullRequest: (s, a, ctx) => { const input = a.input ?? {}; const f = recordFromNode(ctx, input.pullRequestId); const fail = (msg) => { err(ctx, msg); return O('MergePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null }); }; if (!f || f.rec.kind !== 'pull') return fail('Pull request not found'); if (f.rec.merged || f.rec.state === 'closed') return fail('Pull Request is not mergeable'); const method = input.mergeMethod === 'MERGE' ? 'MERGE' : 'SQUASH'; const r = doMergeG(ctx.store, f.repo, f.rec, method, input.commitHeadline, input.commitBody); if ('conflict' in r && r.conflict) return fail('Pull Request is not mergeable'); return O('MergePullRequestPayload', { pullRequest: pullObj(f.repo, f.rec), clientMutationId: input.clientMutationId ?? null }); },
};
function typeFields(names: string[]): any[] {
  return names.map((name) => ({
    name,
    args: [],
    type: { kind: 'SCALAR', name: 'String', fields: null, enumValues: null }
  }));
}
const TYPE_DEFS: Record<string, any> = {
  Issue: {
    kind: 'OBJECT',
    name: 'Issue',
    fields: typeFields(['id','number','title','body','bodyText','bodyHTML','state','stateReason','url','resourcePath','createdAt','updatedAt','closedAt','closed','author','editor','labels','comments','repository','assignees','participants','milestone','reactionGroups','viewerDidAuthor','viewerCanReact','viewerCanUpdate','viewerCanDelete','viewerCanClose','viewerCanReopen','viewerCanComment','locked','activeLockReason','isPinned','databaseId','subIssuesSummary','issueType','parent','blockedBy','blocking','trackedIssues','projectItems','projectCards','createdViaEmail','publishedAt','lastEditedAt'])
  },
  PullRequest: {
    kind: 'OBJECT',
    name: 'PullRequest',
    fields: typeFields(['id','number','title','body','state','merged','mergedAt','mergedBy','mergeable','mergeStateStatus','headRefName','baseRefName','headRefOid','baseRefOid','headRef','baseRef','mergeCommit','potentialMergeCommit','files','commits','comments','labels','author','createdAt','updatedAt','closedAt','closed','url','repository','additions','deletions','changedFiles','isDraft','databaseId','participants','assignees','milestone','reactionGroups','reviews','closingIssuesReferences','isCrossRepository','maintainerCanModify','autoMergeRequest','statusCheckRollup'])
  },
  Repository: {
    kind: 'OBJECT',
    name: 'Repository',
    fields: typeFields(['id','databaseId','name','nameWithOwner','owner','description','isPrivate','url','createdAt','updatedAt','pushedAt','defaultBranchRef','viewerPermission','hasIssuesEnabled','hasProjectsEnabled','hasWikiEnabled','issues','issue','issueOrPullRequest','pullRequests','pullRequest','labels','label','refs','ref','object','stargazerCount','forkCount','watchers','isArchived','isFork','diskUsage','primaryLanguage','licenseInfo','homepageUrl'])
  },
  SearchType: {
    kind: 'ENUM',
    name: 'SearchType',
    fields: null,
    enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'PULL_REQUEST' }, { name: 'USER' }, { name: 'DISCUSSION' }]
  }
};
TYPES.__Type = {
  kind: (t) => t.kind,
  name: (t) => t.name,
  description: () => null,
  fields: (t) => t.fields ? t.fields.map((f) => O('__Field', f)) : null,
  inputFields: () => null,
  interfaces: () => [],
  enumValues: (t) => t.enumValues ? t.enumValues.map((v) => O('__EnumValue', v)) : null,
  possibleTypes: () => null,
  ofType: () => null,
  specifiedByURL: () => null
};
TYPES.__Field = {
  name: (f) => f.name,
  description: () => null,
  args: (f) => (f.args ?? []).map((x) => O('__InputValue', x)),
  type: (f) => O('__Type', f.type),
  isDeprecated: () => false,
  deprecationReason: () => null
};
TYPES.__InputValue = {
  name: (x) => x.name,
  description: () => null,
  type: (x) => O('__Type', x.type),
  defaultValue: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null
};
TYPES.__EnumValue = {
  name: (v) => v.name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null
};
TYPES.__Schema = {
  queryType: () => O('__Type', { kind: 'OBJECT', name: 'Query', fields: [] }),
  mutationType: () => O('__Type', { kind: 'OBJECT', name: 'Mutation', fields: [] }),
  subscriptionType: () => null,
  types: () => [],
  directives: () => []
};
TYPES.Query.__type = (s, a) => {
  const def = TYPE_DEFS[String(a.name ?? '')];
  return def ? O('__Type', def) : null;
};
TYPES.Query.__schema = () => O('__Schema', {});
function gqlSend(res: any, status: number, obj: any): void {
  const id = 'A1B2C3D4E5F67890';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': id
  });
  res.end(JSON.stringify(obj));
}
export function handleGraphQL(req: any, res: any, storeRef: any, body: Buffer): void {
  let parsed: any;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    gqlSend(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const results = docs.map((d) => {
    let doc;
    try {
      doc = parseDocument(String(d.query ?? ''));
    } catch (e: any) {
      return { data: null, errors: [{ message: String(e?.message ?? e) }] };
    }
    const op = d.operationName ? doc.operations.find((o) => o.name === d.operationName) ?? doc.operations[0] : doc.operations[0];
    if (!op) return { data: null, errors: [{ message: 'No operation found' }] };
    const vars: Record<string, any> = {};
    for (const vd of op.varDefs) {
      if (vd.def) vars[vd.name] = valueFromAST(vd.def, {});
    }
    Object.assign(vars, d.variables ?? {});
    const ctx: Ctx = { store: storeRef, vars, fragments: doc.fragments, errors: [] };
    let data: any = null;
    try {
      data = executeOperation(ctx, op, doc);
    } catch (e: any) {
      ctx.errors.push({ message: String(e?.message ?? e) });
    }
    const out: any = { data };
    if (ctx.errors.length) out.errors = ctx.errors;
    return out;
  });
  gqlSend(res, 200, Array.isArray(parsed) ? results : results[0]);
}
// END OF graphql.ts
