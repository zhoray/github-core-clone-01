// Verdant Forge — MCP server (original implementation).
import { store } from './store.ts';
import type { RepoRec, IssueRec } from './store.ts';
import { getObject, putObject, parseCommit, parseTree, formatTree, formatCommit, isAncestor } from './gitcore.ts';

export function mcpRid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

export function toolText(obj: any): { content: { type: string; text: string }[]; isError: boolean } {
  const content = [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }];
  return { content, isError: false };
}

export function toolError(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function repoSummary(repo: RepoRec): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: (store.viewerLogin() ?? 'viewer') + '/' + repo.name,
    owner: { login: store.viewerLogin() ?? 'viewer' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
  };
}

export function issueSummary(rec: IssueRec): any {
  return {
    id: rec.id,
    number: rec.number,
    title: rec.title,
    state: rec.state,
    body: rec.body,
    labels: rec.labels,
    html_url: '',
    url: '',
  };
}

export function pullSummary(repo: RepoRec, rec: IssueRec): any {
  const base = {
    ref: rec.baseRef,
    sha: repo.refs.get('refs/heads/' + rec.baseRef) ?? rec.baseSha,
  };
  const head = {
    ref: rec.headRef,
    sha: repo.refs.get('refs/heads/' + rec.headRef) ?? rec.headSha,
  };
  return {
    ...issueSummary(rec),
    head,
    base,
    merged: rec.merged,
    merge_commit_sha: rec.mergeCommitSha,
  };
}

const S = { type: 'string' };
const N = { type: 'number' };
const B = { type: 'boolean' };
const AS = { type: 'array', items: { type: 'string' } };

function schema(props: Record<string, any>, required: string[]): any {
  return { type: 'object', properties: props, required };
}

export const TOOLS: any[] = [
  {
    name: 'create_repository',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema({ name: S, private: B, description: S, autoInit: B }, ['name']),
  },
  {
    name: 'list_repositories',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: schema({ owner: S, page: N, perPage: N }, []),
  },
  {
    name: 'get_repository',
    description: 'Get details of a repository.',
    inputSchema: schema({ owner: S, repo: S }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: schema({ owner: S, repo: S, title: S, body: S, labels: AS }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: schema({ owner: S, repo: S, state: S, page: N, perPage: N }, ['owner', 'repo']),
  },
  {
    name: 'get_issue',
    description: 'Get details of an issue.',
    inputSchema: schema({ owner: S, repo: S, issue_number: N }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: schema({ owner: S, repo: S, issue_number: N, body: S }, ['owner', 'repo', 'issue_number', 'body']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request.',
    inputSchema: schema({ owner: S, repo: S, title: S, body: S, head: S, base: S, draft: B }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: schema({ owner: S, repo: S, state: S, page: N, perPage: N }, ['owner', 'repo']),
  },
  {
    name: 'get_pull_request',
    description: 'Get details of a pull request.',
    inputSchema: schema({ owner: S, repo: S, pullNumber: N }, ['owner', 'repo', 'pullNumber']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: S, repo: S, pullNumber: N, merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commit_title: S, commit_message: S }, required: ['owner', 'repo', 'pullNumber'] },
  },
  {
    name: 'list_branches',
    description: 'List branches of a repository.',
    inputSchema: schema({ owner: S, repo: S }, ['owner', 'repo']),
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file in a repository.',
    inputSchema: schema({ owner: S, repo: S, path: S, branch: S }, ['owner', 'repo', 'path']),
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a file in a repository.',
    inputSchema: schema({ owner: S, repo: S, path: S, content: S, message: S, branch: S, sha: S }, ['owner', 'repo', 'path', 'content', 'message']),
  },
];
function flattenT(repo: any, treeSha: string | null): Map<string, string> {
  const flat = new Map<string, string>();
  if (!treeSha) return flat;
  const walk = (sha: string, prefix: string): void => {
    const treeObj = getObject(repo, sha);
    if (!treeObj || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const p = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.mode === '40000') walk(entry.sha, p);
      else flat.set(p, entry.sha);
    }
  };
  walk(treeSha, '');
  return flat;
}
function buildT(repo: any, flat: Map<string, string>): string {
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
function treeOf(repo: any, sha: string): string | null {
  try {
    const c = getObject(repo, sha);
    if (c && c.type === 'commit') return parseCommit(c.data).tree;
  } catch {}
  return null;
}
function mergeBaseM(repo: any, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  let q: string[] = [a];
  while (q.length) {
    const cur = q.shift()!;
    if (ancestors.has(cur)) continue;
    ancestors.add(cur);
    const c = getObject(repo, cur);
    if (c && c.type === 'commit') {
      for (const p of parseCommit(c.data).parents) {
        q.push(p);
      }
    }
  }
  const seen = new Set<string>();
  q = [b];
  while (q.length) {
    const cur = q.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancestors.has(cur)) return cur;
    const c = getObject(repo, cur);
    if (c && c.type === 'commit') {
      for (const p of parseCommit(c.data).parents) {
        q.push(p);
      }
    }
  }
  return null;
}
function computeMergeM(repo: any, baseTip: string, headTip: string): { conflict: boolean; treeSha?: string } {
  const mb = mergeBaseM(repo, baseTip, headTip);
  if (!mb) return { conflict: true };
  const mbMap = flattenT(repo, treeOf(repo, mb));
  const baseMap = flattenT(repo, treeOf(repo, baseTip));
  const headMap = flattenT(repo, treeOf(repo, headTip));
  const merged = new Map<string, string>();
  const paths = new Set([...mbMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const mbV = mbMap.get(path) ?? null;
    const baseV = baseMap.get(path) ?? null;
    const headV = headMap.get(path) ?? null;
    let pick: string | null = null;
    if (headV === mbV) pick = baseV;
    else if (baseV === mbV) pick = headV;
    else if (baseV === headV) pick = baseV;
    else return { conflict: true };
    if (pick !== null) merged.set(path, pick);
  }
  return { conflict: false, treeSha: buildT(repo, merged) };
}
function doMergeM(repo: any, rec: IssueRec, method: string, title?: string, message?: string): { sha: string } | { conflict: true } {
  const baseTip = repo.refs.get('refs/heads/' + rec.baseRef);
  const headTip = repo.refs.get('refs/heads/' + rec.headRef) ?? rec.headSha;
  if (!baseTip || !headTip) return { conflict: true };
  const cm = computeMergeM(repo, baseTip, headTip);
  if (cm.conflict || !cm.treeSha) return { conflict: true };
  const ident = store.viewer()!.name + ' <' + store.viewer()!.email + '> ' + Math.floor(Date.now() / 1000) + ' +0000';
  let parents: string[];
  if (method === 'merge') {
    parents = [baseTip, headTip];
  } else if (method === 'squash' || method === 'rebase') {
    parents = [baseTip];
  } else {
    return { conflict: true };
  }
  const commitData = {
    tree: cm.treeSha,
    parents,
    author: ident,
    committer: ident,
    message: (title ?? rec.title + ' (#' + rec.number + ')') + '\n\n' + (message ?? ''),
  };
  const sha = putObject(repo, 'commit', formatCommit(commitData));
  repo.refs.set('refs/heads/' + rec.baseRef, sha);
  rec.merged = true;
  rec.mergedAt = new Date().toISOString();
  rec.mergeCommitSha = sha;
  rec.state = 'closed';
  rec.closedAt = rec.mergedAt;
  return { sha };
}
export function callTool(name: string, args: any): any {
  const aliases = { num: ['pullNumber', 'pull_number', 'number', 'issue_number'] };
  const method = args.merge_method ?? args.mergeMethod ?? 'squash';
  function need(keys: string[]): string | null {
    for (let k of keys) {
      if (args[k] === undefined || args[k] === null || args[k] === '') return k;
    }
    return null;
  }
  if (name === 'create_repository') {
    const newName = args.name;
    if (!newName) return toolError('missing required argument: name');
    const created = store.createRepo({ name: newName, private: !!args.private, description: args.description ?? '' });
    return toolText(repoSummary(created));
  }
  if (name === 'list_repositories') {
    let all = store.listRepos().map(repoSummary);
    const page = args.page ?? 1;
    const perPage = args.perPage ?? 30;
    all = all.slice((page - 1) * perPage, page * perPage);
    return toolText(all);
  }
  const repo = repoOf(args);
  if (!repo) return toolError('repository not found');
  switch (name) {
    case 'get_repository':
      return toolText(repoSummary(repo));
    case 'create_issue':
      const o = args.owner ?? repo.ownerLogin ?? 'viewer';
      const r = args.repo;
      if (!r) return toolError('missing required argument: repo');
      const title = args.title;
      if (!title) return toolError('missing required argument: title');
      const labels = args.labels ?? [];
      for (const l of labels) {
        if (!repo.labels.has(l)) return toolError('unknown label: ' + l);
      }
      const rec = store.createIssue(repo, { title, body: args.body ?? '', labels });
      return toolText(issueSummary(rec));
    case 'list_issues':
      const state = args.state ?? 'open';
      let recs = store.listIssuesOnly(repo).filter((r: IssueRec) => state === 'all' || r.state === state);
      const p = args.page ?? 1;
      const pp = args.perPage ?? 30;
      recs = recs.slice((p - 1) * pp, p * pp);
      return toolText(recs.map(issueSummary));
    case 'get_issue':
      const num = args.num ?? args.issue_number;
      const irec = store.getIssue(repo, num);
      if (!irec) return toolError('issue not found');
      return toolText({ ...issueSummary(irec), comments: irec.comments.length });
    case 'add_issue_comment':
      const crec = store.getIssue(repo, args.num ?? args.issue_number);
      if (!crec) return toolError('issue not found');
      const body = args.body;
      if (!body) return toolError('missing body');
      const c = store.addComment(repo, crec.number, body);
      return toolText({ id: c.id, body: c.body });
    case 'create_pull_request':
      const head = (args.head ?? '').replace(/^owner:/, '');
      const base = (args.base ?? '').replace(/^owner:/, '') || repo.defaultBranch;
      const hTip = repo.refs.get('refs/heads/' + head) ?? null;
      const bTip = repo.refs.get('refs/heads/' + base) ?? null;
      if (!hTip || !bTip || hTip === bTip || isAncestor(repo, hTip, bTip)) return toolError('head or base branch not found');
      const prec = store.createPull(repo, { title: args.title, body: args.body ?? '', headRef: head, headSha: hTip, baseRef: base, baseSha: bTip, draft: !!args.draft });
      return toolText(pullSummary(repo, prec));
    case 'list_pull_requests':
      const lstate = args.state ?? 'open';
      let lrecs = store.listPullsOnly(repo).filter((r: IssueRec) => lstate === 'all' || (r.merged && lstate === 'closed') || r.state === lstate);
      const lp = args.page ?? 1;
      const lpp = args.perPage ?? 30;
      lrecs = lrecs.slice((lp - 1) * lpp, lp * lpp);
      return toolText(lrecs.map((r: IssueRec) => pullSummary(repo, r)));
    case 'get_pull_request':
      const nump = args.num ?? args.pullNumber;
      const prec2 = store.getPull(repo, nump);
      if (!prec2) return toolError('pull request not found');
      return toolText(pullSummary(repo, prec2));
    case 'merge_pull_request':
      const mrec = store.getPull(repo, args.num ?? args.pullNumber);
      if (!mrec) return toolError('pull request not found');
      if (mrec.merged || mrec.state === 'closed') return toolError('Pull Request is not mergeable');
      const mr = doMergeM(repo, mrec, method, args.commit_title, args.commit_message);
      if ('conflict' in mr) return toolError('Pull Request is not mergeable');
      return toolText({ sha: mr.sha, merged: true, message: 'Pull Request successfully merged' });
    case 'list_branches':
      const branches: any[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          const name = ref.replace('refs/heads/', '');
          branches.push({ name, commit: { sha }, protected: false });
        }
      }
      branches.sort((a, b) => a.name.localeCompare(b.name));
      return toolText(branches);
    case 'get_file_contents':
      const branchRef = 'refs/heads/' + (args.branch ?? repo.defaultBranch);
      const tip = repo.refs.get(branchRef);
      const tree = tip ? treeOf(repo, tip) : null;
      const flat = flattenT(repo, tree);
      const sha = flat.get(args.path);
      if (sha === undefined) return toolError('path not found');
      const content = getObject(repo, sha).data.toString('utf8');
      return toolText(content);
    case 'create_or_update_file':
      const cbranchRef = 'refs/heads/' + (args.branch ?? repo.defaultBranch);
      const ctip = repo.refs.get(cbranchRef);
      const crootTree = ctip ? treeOf(repo, ctip) : null;
      const cflat = flattenT(repo, crootTree);
      const cexisting = cflat.get(args.path);
      if (cexisting && args.sha && args.sha !== cexisting) return toolError('sha mismatch');
      const cblobSha = putObject(repo, 'blob', Buffer.from(String(args.content ?? ''), 'utf8'));
      const cnewFlat = new Map(cflat);
      cnewFlat.set(args.path, cblobSha);
      const cnewTree = buildT(repo, cnewFlat);
      const cident = store.viewer()!.name + ' <' + store.viewer()!.email + '> ' + Math.floor(Date.now() / 1000) + ' +0000';
      const ccommit = formatCommit({
        tree: cnewTree,
        parents: ctip ? [ctip] : [],
        author: cident,
        committer: cident,
        message: args.message ?? '',
      });
      const csha = putObject(repo, 'commit', ccommit);
      repo.refs.set(cbranchRef, csha);
      return toolText({ content: { path: args.path, sha: cblobSha }, commit: { sha: csha } });
    default:
      throw { code: -32602, message: 'Tool ' + name + ' not found' };
  }
}
function repoOf(args: any): any {
  let owner = args.owner;
  if (owner === undefined) owner = store.viewerLogin() ?? 'viewer';
  const repoName = args.repo;
  if (!repoName) return null;
  const repo = store.getRepo(owner, repoName);
  return repo;
}
export function handleMcp(req: any, res: any, storeRef: any, body: Buffer): void {
  function send(status: number, obj: any): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': mcpRid(),
    });
    if (obj === undefined) {
      res.end('');
    } else {
      res.end(JSON.stringify(obj));
    }
  }
  if (req.method !== 'POST') {
    send(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not supported' } });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body.toString());
  } catch (e) {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const isBatch = Array.isArray(parsed);
  const items = isBatch ? parsed : [parsed];
  const responses: any[] = [];
  for (const item of items) {
    if (!('id' in item)) {
      continue;
    }
    const id = item.id;
    const method = item.method;
    const params = item.params ?? {};
    let response: any;
    if (method === 'initialize') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'verdant-forge', version: '1.0.0' },
        },
      };
    } else if (method === 'server/discover') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: { name: 'verdant-forge', version: '1.0.0' },
        },
      };
    } else if (method === 'ping') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {},
      };
    } else if (method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };
    } else if (method === 'tools/call') {
      try {
        const result = callTool(params.name, params.arguments ?? {});
        response = {
          jsonrpc: '2.0',
          id,
          result,
        };
      } catch (e: any) {
        let error: any;
        if (e && typeof e.code === 'number') {
          error = { code: e.code, message: e.message };
        } else {
          error = toolError(String(e?.message ?? e));
        }
        response = {
          jsonrpc: '2.0',
          id,
          error,
        };
      }
    } else {
      response = {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found: ' + method },
      };
    }
    responses.push(response);
  }
  if (responses.length === 0) {
    send(202, undefined);
  } else {
    send(200, isBatch ? responses : responses[0]);
  }
}
