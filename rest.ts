 // Verdant Forge — REST v3 surface (original implementation).
import { store, nowIso, nodeId } from './store.ts';
import type { RepoRec } from './store.ts';
import { userJson, repoJson, labelJson, issueJson, pullJson, commentJson, branchJson } from './shapes.ts';
import { getObject, putObject, parseCommit, formatCommit, parseTree, formatTree, treeDiff, diffLineCounts, isAncestor } from './gitcore.ts';

export function rid(): string {
  const hex = '0123456789ABCDEF';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += hex[Math.floor(Math.random() * 16)];
  }
  return result;
}

export function send(res: any, status: number, obj: any): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': rid() });
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': rid()
  });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

export function notFound(res: any): void {
  send(res, 404, { message: 'Not Found' });
}

export function parseBody(body: Buffer): any | null {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

export function paginate(
  req: any,
  res: any,
  path: string,
  query: URLSearchParams,
  items: any[]
): any[] {
  const per_page = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1') || 1);
  const slice = items.slice((page - 1) * per_page, page * per_page);
  if (items.length > page * per_page) {
    const lastPage = Math.ceil(items.length / per_page);
    const host = req.headers.host || 'localhost';
    const base = 'http://' + host + path;
    const link = `<${base}?per_page=${per_page}&page=${page + 1}>; rel="next", <${base}?per_page=${per_page}&page=${lastPage}>; rel="last"`;
    res.setHeader('link', link);
  }
  return slice;
}
function parseTreeOf(repo: RepoRec, treeSha: string): Array<{mode: string, name: string, sha: string}> {
  if (!treeSha || !repo.objects.has(treeSha)) {
    return [];
  }
  const buf = repo.objects.get(treeSha)!.data;
  const entries: Array<{mode: string, name: string, sha: string}> = [];
  let pos = 0;
  while (pos < buf.length) {
    const spaceIdx = buf.indexOf(32, pos);
    if (spaceIdx === -1) break;
    const mode = buf.slice(pos, spaceIdx).toString('ascii');
    pos = spaceIdx + 1;
    const nulIdx = buf.indexOf(0, pos);
    if (nulIdx === -1) break;
    const name = buf.slice(pos, nulIdx).toString('utf8');
    pos = nulIdx + 1;
    const sha = buf.slice(pos, pos + 20).toString('hex');
    entries.push({mode, name, sha});
    pos += 20;
  }
  return entries;
}

export function flattenTree(repo: RepoRec, treeSha: string | null): Map<string, { sha: string; mode: string }> {
  const flat = new Map<string, { sha: string; mode: string }>();
  if (!treeSha) return flat;
  const walk = (sha: string, prefix: string = '') => {
    const entries = parseTreeOf(repo, sha);
    for (const {mode, name, sha: eSha} of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode.startsWith('04')) {
        walk(eSha, path);
      } else {
        flat.set(path, {sha: eSha, mode});
      }
    }
  };
  walk(treeSha);
  return flat;
}

export function buildTree(repo: RepoRec, flat: Map<string, { sha: string; mode: string }>): string {
  if (flat.size === 0) {
    return putObject(repo, 'tree', Buffer.alloc(0));
  }
  const groups = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [path, entry] of flat) {
    const slashIdx = path.indexOf('/');
    if (slashIdx === -1) {
      // file at root
    } else {
      const dir = path.slice(0, slashIdx);
      const rest = path.slice(slashIdx + 1);
      if (!groups.has(dir)) groups.set(dir, new Map());
      groups.get(dir)!.set(rest, entry);
    }
  }
  const entries: {mode: string, name: string, sha: string}[] = [];
  for (const [dir, submap] of groups) {
    const subSha = buildTree(repo, submap);
    entries.push({mode: '040000', name: dir, sha: subSha});
  }
  for (const [path, entry] of flat) {
    const slashIdx = path.indexOf('/');
    if (slashIdx === -1) {
      entries.push({mode: entry.mode, name: path, sha: entry.sha});
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const treeData = formatTree(entries);
  return putObject(repo, 'tree', treeData);
}

export function applyTreeChange(repo: RepoRec, rootTree: string | null, path: string, blobSha: string | null): string {
  let flat = flattenTree(repo, rootTree);
  if (blobSha !== null) {
    flat.set(path, { sha: blobSha, mode: '100644' });
  } else {
    flat.delete(path);
  }
  return buildTree(repo, flat);
}

export function viewerIdent(repo: RepoRec): string {
  const v = store.viewer();
  const ts = Math.floor(Date.parse(nowIso()) / 1000);
  return v.name + ' <' + v.email + '> ' + ts + ' +0000';
}

export function makeCommit(repo: RepoRec, branchRef: string, treeSha: string, message: string): string {
  let tip = repo.refs.get(branchRef);
  const parents = tip ? [tip] : [];
  const ident = viewerIdent(repo);
  const data = formatCommit({ tree: treeSha, parents, author: ident, committer: ident, message });
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(branchRef, sha);
  repo.updatedAt = nowIso();
  repo.pushedAt = repo.updatedAt;
  if (branchRef === repo.headRef) {
    // nothing extra
  }
  return sha;
}

export function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (!ref || ref === '') {
    return repo.refs.get(repo.headRef) || null;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) {
    return ref;
  }
  const headsRef = 'refs/heads/' + ref;
  if (repo.refs.has(headsRef)) {
    return repo.refs.get(headsRef) || null;
  }
  if (repo.refs.has(ref)) {
    return repo.refs.get(ref) || null;
  }
  return null;
}

function parseCommitOf(repo: RepoRec, sha: string): {tree?: string; parents: string[]} | null {
  const buf = repo.objects.get(sha)?.data;
  if (!buf) return null;
  const bodyStart = buf.indexOf('\n\n');
  if (bodyStart === -1) return null;
  const headers = buf.slice(0, bodyStart).toString('utf8');
  const treeMatch = headers.match(/^\s*tree\s+([0-9a-f]{40})/m);
  if (!treeMatch) return null;
  const parents = [...headers.matchAll(/^parent ([0-9a-f]{40})/gm)].map((x) => x[1]);
  return {tree: treeMatch[1], parents};
}

export function treeOfCommit(repo: RepoRec, sha: string): string | null {
  return parseCommitOf(repo, sha)?.tree ?? null;
}
function commitNode(sha) {
  return Buffer.from('Commit:' + sha, 'utf8').toString('base64');
}
function parseIdent(identLine) {
  const match = identLine.match(/^(.+?)\s+<([^>]+)>\s+(\d+)\s+(.+)$/);
  if (!match) {
    return { name: '', email: '', date: new Date().toISOString() };
  }
  const [, name, email, ts, tz] = match;
  return { name: name.trim(), email, date: new Date(Number(ts) * 1000).toISOString() };
}
function commitItem(repo, sha) {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  return {
    sha,
    node_id: commitNode(sha),
    commit: { author: parseIdent(c.author), committer: parseIdent(c.committer), message: c.message, tree: { sha: c.tree, url: '' }, comment_count: 0 },
    url: '',
    parents: c.parents.map((p) => ({ sha: p, url: '' }))
  };
}
export function hRoot(req, res) {
  res.setHeader('x-oauth-scopes', 'repo, read:org');
  send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}', issue_url: '/api/v3/repos/{owner}/{repo}/issues' });
  return true;
}
export function hMeta(req, res) {
  send(res, 200, { installed_version: '1.0.0' });
  return true;
}
export function hUser(req, res) {
  send(res, 200, store.viewer());
  return true;
}
export function hCreateRepo(req, res, _m, _q, body) {
  let b;
  try {
    b = parseBody(body);
  } catch {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (b === null) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (typeof b.name !== 'string' || b.name.trim() === '') {
    send(res, 422, { message: 'Repository creation failed.' });
    return true;
  }
  const name = b.name.trim();
  if (store.getRepoByName(name)) {
    send(res, 422, { message: 'Repository creation failed.' });
    return true;
  }
  const repo = store.createRepo({ name, private: !!b.private, description: b.description ?? '', defaultBranch: b.default_branch });
  send(res, 201, repoJson(repo));
  return true;
}
export function hListUserRepos(req, res, _m, query) {
  const items = store.listRepos().map(repoJson);
  send(res, 200, paginate(req, res, '/api/v3/user/repos', query, items));
  return true;
}
export function hRepo(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  send(res, 200, repoJson(repo));
  return true;
}
export function hPatchRepo(req, res, m, _q, body) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  let b;
  try {
    b = parseBody(body);
  } catch {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (b === null) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (b.description !== undefined) {
    repo.description = b.description;
  }
  if (b.name !== undefined) {
    const name = b.name;
    if (typeof name === 'string' && name.trim() !== '' && !store.getRepoByName(name.trim())) {
      repo.name = name.trim();
    }
  }
  if (b.private !== undefined) {
    repo.private = !!b.private;
  }
  if (b.default_branch !== undefined) {
    repo.defaultBranch = b.default_branch;
    repo.headRef = 'refs/heads/' + b.default_branch;
  }
  repo.updatedAt = nowIso();
  send(res, 200, repoJson(repo));
  return true;
}
export function hDeleteRepo(req, res, m) {
  if (!store.deleteRepo(m[1], m[2])) {
    notFound(res);
    return true;
  }
  send(res, 204, undefined);
  return true;
}
export function hBranches(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const list = Array.from(repo.refs.keys())
    .filter(k => k.startsWith('refs/heads/'))
    .map(k => {
      const short = k.substring(11);
      const sha = repo.refs.get(k) as string;
      return branchJson(repo, short, sha);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  send(res, 200, list);
  return true;
}
export function hBranch(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const branch = m[3];
  const sha = repo.refs.get('refs/heads/' + branch);
  if (sha === undefined) {
    notFound(res);
    return true;
  }
  send(res, 200, branchJson(repo, branch, sha));
  return true;
}
export function hCommits(req, res, m, query) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  let startRef = query.get('sha');
  let tip = null;
  if (startRef) {
    tip = resolveRef(repo, startRef);
    if (!tip) {
      send(res, 200, []);
      return true;
    }
  } else {
    tip = repo.refs.get(repo.headRef) ?? null;
  }
  const visited = new Set();
  const queue = [];
  if (tip) queue.push(tip);
  const commitList = [];
  while (queue.length > 0) {
    const sha = queue.shift();
    if (visited.has(sha)) continue;
    visited.add(sha);
    const obj = getObject(repo, sha);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      const match = c.committer ? c.committer.match(/\d+/) : null;
      const ts = match ? Number(match[0]) : 0;
      commitList.push({ sha, ts });
      const parents = c.parents || [];
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  }
  commitList.sort((a, b) => b.ts - a.ts);
  const items = commitList.map(item => commitItem(repo, item.sha));
  const path = '/api/v3/repos/' + m[1] + '/' + m[2] + '/commits';
  send(res, 200, paginate(req, res, path, query, items));
  return true;
}
export function hCommit(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const obj = getObject(repo, m[3]);
  if (!obj || obj.type !== 'commit') {
    notFound(res);
    return true;
  }
  send(res, 200, commitItem(repo, m[3]));
  return true;
}
export function hCreateRef(req, res, m, _q, body) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  let b;
  try {
    b = parseBody(body);
  } catch {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (b === null) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  let ref = b.ref;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    send(res, 422, { message: 'Invalid ref' });
    return true;
  }
  const sha = b.sha;
  if (typeof sha !== 'string' || !sha) {
    send(res, 422, { message: 'Invalid object' });
    return true;
  }
  const target = getObject(repo, sha);
  if (!target) {
    send(res, 422, { message: 'Invalid object' });
    return true;
  }
  const full = ref;
  if (repo.refs.has(full)) {
    send(res, 422, { message: 'Reference already exists' });
    return true;
  }
  repo.refs.set(full, sha);
  send(res, 201, { ref: full, node_id: '', url: '', object: { type: target.type, sha, url: '' } });
  return true;
}
export function hGetRef(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const refPath = m[3];
  const full = 'refs/' + refPath;
  const sha = repo.refs.get(full);
  if (sha === undefined) {
    notFound(res);
    return true;
  }
  const obj = getObject(repo, sha);
  const type = obj ? obj.type : 'commit';
  send(res, 200, { ref: full, node_id: '', url: '', object: { type, sha, url: '' } });
  return true;
}
export function hListRefs(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const list = Array.from(repo.refs.entries())
    .map(([ref, sha]) => {
      const obj = getObject(repo, sha);
      const type = obj ? obj.type : 'commit';
      return { ref, node_id: '', url: '', object: { type, sha, url: '' } };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
  send(res, 200, list);
  return true;
}
export function hDeleteRef(req, res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  const full = 'refs/' + m[3];
  if (!repo.refs.has(full)) {
    notFound(res);
    return true;
  }
  repo.refs.delete(full);
  send(res, 204, undefined);
  return true;
}
export function contentTarget(req: any, res: any, m: RegExpMatchArray, query: URLSearchParams): { repo: RepoRec; treeSha: string | null } | null {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return null;
  }
  const refParam = query.get('ref');
  const tip = resolveRef(repo, refParam);
  const treeSha = tip ? treeOfCommit(repo, tip) : null;
  return { repo, treeSha };
}

export function hGetContents(req: any, res: any, m: RegExpMatchArray, query: URLSearchParams, body: Buffer): boolean {
  const target = contentTarget(req, res, m, query);
  if (!target) return true;
  const path = m[3] ?? '';
  const flat = flattenTree(target.repo, target.treeSha);
  if (path !== '') {
    if (flat.has(path)) {
      const { sha: blobSha } = flat.get(path)!;
      const blob = getObject(target.repo, blobSha);
      if (blob && blob.type === 'blob') {
        const content = blob.data.toString('base64');
        const resp = {
          name: path.split('/').pop()!,
          path,
          sha: blobSha,
          size: blob.data.length,
          type: 'file',
          encoding: 'base64',
          content,
          url: '',
          html_url: '',
          download_url: '',
          _links: {
            self: '',
            git: '',
            html: ''
          }
        };
        send(res, 200, resp);
      }
      return true;
    } else {
      // directory check
      const prefix = path + '/';
      const children = [];
      let matched = false;
      for (const [entryPath, entry] of flat.entries()) {
        if (entryPath === path || entryPath.startsWith(prefix)) {
          matched = true;
          const name = entryPath.split('/').pop()!;
          const isDir = entryPath.endsWith('/') || flat.has(entryPath + '/');
          const sha = isDir ? entry.sha : null;
          const size = isDir ? 0 : entryPath === path ? getObject(target.repo, entry.sha).data.length : null;
          children.push({
            name,
            path: entryPath,
            sha: sha || entry.sha,
            size: size || 0,
            type: isDir ? 'dir' : 'file',
            url: '',
            download_url: ''
          });
        }
      }
      if (!matched) {
        notFound(res);
        return true;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      send(res, 200, children);
      return true;
    }
  } else {
    // root directory
    const children = [];
    for (const [entryPath, entry] of flat.entries()) {
      if (!entryPath.includes('/')) {
        const blob = getObject(target.repo, entry.sha);
        children.push({
          name: entryPath,
          path: entryPath,
          sha: entry.sha,
          size: blob.data.length,
          type: 'file',
          url: '',
          download_url: ''
        });
      }
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    send(res, 200, children);
    return true;
  }
}

function dirList(repo: RepoRec, treeSha: string | null, path: string): any[] {
  if (!treeSha) return [];
  let entries: Array<{mode: string, name: string, sha: string}> = [];
  if (path === '') {
    entries = parseTreeOf(repo, treeSha);
  } else {
    const obj = getObject(repo, treeSha);
    if (obj && obj.type === 'tree') {
      entries = parseTreeOf(repo, treeSha);
    }
  }
  const children = [];
  for (const {mode, name, sha} of entries) {
    const fullPath = path ? (path + '/' + name) : name;
    const isDir = mode.startsWith('04');
    children.push({
      name,
      path: fullPath,
      sha,
      size: isDir ? 0 : getObject(repo, sha).data.length,
      type: isDir ? 'dir' : 'file',
      url: '',
      download_url: ''
    });
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

export function hPutContents(req: any, res: any, m: RegExpMatchArray, _q: URLSearchParams, body: Buffer): boolean {
  const target = contentTarget(req, res, m, _q);
  if (!target) return true;
  let b = parseBody(body);
  if (b === null) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  const path = m[3];
  const branchRef = 'refs/heads/' + (b.branch ?? target.repo.defaultBranch);
  const tip = target.repo.refs.get(branchRef);
  const rootTree = tip ? treeOfCommit(target.repo, tip) : null;
  const flat = flattenTree(target.repo, rootTree);
  const existing = flat.get(path);
  if (existing && b.sha === undefined) {
    send(res, 422, { message: 'sha is required' });
    return true;
  }
  if (existing && b.sha !== existing.sha) {
    send(res, 409, { message: 'sha mismatch' });
    return true;
  }
  let data: Buffer;
  if (b.content) {
    data = Buffer.from(String(b.content), 'base64');
  } else {
    data = Buffer.alloc(0);
  }
  const blobSha = putObject(target.repo, 'blob', data);
  const newTree = applyTreeChange(target.repo, rootTree, path, blobSha);
  const message = b.message ?? (existing ? 'Update ' + path : 'Create ' + path);
  const commitSha = makeCommit(target.repo, branchRef, newTree, message);
  const respContent = {
    name: require('path').basename(path),
    path,
    sha: blobSha,
    size: data.length,
    type: 'file',
    encoding: 'base64',
    url: '',
    html_url: '',
    download_url: '',
    _links: {
      self: '',
      git: '',
      html: ''
    }
  };
  send(res, existing ? 200 : 201, { content: respContent, commit: { sha: commitSha, message } });
  return true;
}

export function hDeleteContents(req: any, res: any, m: RegExpMatchArray, _q: URLSearchParams, body: Buffer): boolean {
  const target = contentTarget(req, res, m, _q);
  if (!target) return true;
  let b = parseBody(body);
  if (b === null) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  const path = m[3];
  const branchRef = 'refs/heads/' + (b.branch ?? target.repo.defaultBranch);
  const tip = target.repo.refs.get(branchRef);
  const rootTree = tip ? treeOfCommit(target.repo, tip) : null;
  const flat = flattenTree(target.repo, rootTree);
  const existing = flat.get(path);
  if (!existing) {
    notFound(res);
    return true;
  }
  if (b.sha !== existing.sha) {
    send(res, 409, { message: 'sha mismatch' });
    return true;
  }
  const newTree = applyTreeChange(target.repo, rootTree, path, null);
  const message = b.message ?? 'Delete ' + path;
  const commitSha = makeCommit(target.repo, branchRef, newTree, message);
  send(res, 200, { content: null, commit: { sha: commitSha, message } });
  return true;
}
function repoOf(res, m) {
  const repo = store.getRepo(m[1], m[2]);
  if (!repo) {
    notFound(res);
    return true;
  }
  return repo;
}

function validLabels(repo, names) {
  if (!names) return true;
  for (const name of names) {
    if (!repo.labels.has(name)) return false;
  }
  return true;
}

export function hCreateIssue(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const b = parseBody(body);
  if (!b) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Problems parsing JSON' }));
    return true;
  }
  if (!b.title || typeof b.title !== 'string' || b.title.trim() === '') {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Validation Failed: title is required' }));
    return true;
  }
  const labels = b.labels ?? [];
  if (!validLabels(repo, labels)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Validation Failed: label not found' }));
    return true;
  }
  const rec = store.createIssue(repo, { title: b.title, body: b.body ?? '', labels });
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(issueJson(repo, rec)));
  return true;
}

export function hListIssues(req, res, m, query) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const state = query.get('state') ?? 'open';
  const all = Array.from(repo.issues.values());
  let filtered = all;
  if (state === 'open') {
    filtered = all.filter((r) => r.state === 'open');
  } else if (state === 'closed') {
    filtered = all.filter((r) => r.state === 'closed');
  } // 'all' uses all
  const direction = query.get('direction') ?? 'desc';
  const sorted = [...filtered].sort((a, b) => {
    return direction === 'desc' ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt);
  });
  const items = sorted.map((r) => issueJson(repo, r));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(paginate(req, res, '/api/v3/repos/' + m[1] + '/' + m[2] + '/issues', query, items)));
  return true;
}

export function hGetIssue(req, res, m) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const num = parseInt(m[3], 10);
  const rec = store.getIssue(repo, num);
  if (!rec) {
    notFound(res);
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(issueJson(repo, rec)));
  return true;
}

export function hPatchIssue(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const rec = store.getIssue(repo, parseInt(m[3], 10));
  if (!rec) {
    notFound(res);
    return true;
  }
  const b = parseBody(body);
  if (!b) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Problems parsing JSON' }));
    return true;
  }
  if (b.labels !== undefined) {
    if (!validLabels(repo, b.labels)) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Validation Failed: label not found' }));
      return true;
    }
    rec.labels = b.labels;
  }
  if (typeof b.title === 'string') {
    rec.title = b.title;
  }
  if (typeof b.body === 'string') {
    rec.body = b.body;
  }
  if (b.state === 'closed') {
    rec.state = 'closed';
    rec.closedAt = nowIso();
  } else if (b.state === 'open') {
    rec.state = 'open';
    rec.closedAt = null;
  }
  rec.updatedAt = nowIso();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(issueJson(repo, rec)));
  return true;
}
export function hCreateComment(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  let rec = store.getIssue(repo, parseInt(m[3], 10));
  if (!rec) {
    notFound(res);
    return true;
  }
  let b;
  try {
    b = parseBody(body);
  } catch (e) {
    send(res, 400, { message: 'Bad Request' });
    return true;
  }
  if (!b.body || b.body.trim() === '') {
    send(res, 422, { message: 'Validation Failed: body is required' });
    return true;
  }
  const c = store.addComment(repo, rec.number, b.body);
  send(res, 201, commentJson(repo, rec, c));
  return true;
}

export function hListComments(req, res, m, query) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  let rec = store.getIssue(repo, parseInt(m[3], 10));
  if (!rec) {
    notFound(res);
    return true;
  }
  const items = rec.comments.map((c) => commentJson(repo, rec, c));
  send(res, 200, paginate(req, res, '/api/v3/repos/' + m[1] + '/' + m[2] + '/issues/' + m[3] + '/comments', query, items));
  return true;
}

export function hListLabels(req, res, m) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  send(res, 200, store.listLabels(repo).map(labelJson));
  return true;
}

export function hCreateLabel(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  let b;
  try {
    b = parseBody(body);
  } catch (e) {
    send(res, 400, { message: 'Bad Request' });
    return true;
  }
  if (!b.name) {
    send(res, 422, { message: 'Validation Failed: name is required' });
    return true;
  }
  if (store.getLabel(repo, b.name)) {
    send(res, 422, { message: 'Validation Failed: label already exists' });
    return true;
  }
  const l = store.createLabel(repo, { name: b.name, color: b.color, description: b.description });
  send(res, 201, labelJson(l));
  return true;
}

export function hGetLabel(req, res, m) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  let l = store.getLabel(repo, m[3]);
  if (!l) {
    notFound(res);
    return true;
  }
  send(res, 200, labelJson(l));
  return true;
}
export function hCreatePull(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const b = parseBody(body);
  if (!b) {
    send(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (!b.title) {
    send(res, 422, { message: 'Validation Failed: title is required' });
    return true;
  }
  const head = stripOwner(String(b.head ?? ''));
  const base = stripOwner(String(b.base ?? repo.defaultBranch));
  const headTip = repo.refs.get('refs/heads/' + head);
  const baseTip = repo.refs.get('refs/heads/' + base);
  if (!headTip || !baseTip) {
    send(res, 422, { message: 'Validation Failed: head or base branch not found' });
    return true;
  }
  if (headTip === baseTip || isAncestor(repo, headTip, baseTip)) {
    send(res, 422, { message: 'No commits between ' + base + ' and ' + head });
    return true;
  }
  const existing = store.listPullsOnly(repo).find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
  if (existing) {
    send(res, 422, { message: 'A pull request already exists for this branch' });
    return true;
  }
  const rec = store.createPull(repo, { title: b.title, body: b.body ?? '', headRef: head, baseRef: base, headSha: headTip, baseSha: baseTip });
  send(res, 201, pullJsonFresh(repo, rec));
  return true;
}

export function hListPulls(req, res, m, query) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const state = query.get('state') ?? 'open';
  let recs = store.listPullsOnly(repo);
  if (state === 'open') recs = recs.filter(r => r.state === 'open');
  else if (state === 'closed') recs = recs.filter(r => r.state === 'closed');
  const direction = query.get('direction') ?? 'desc';
  recs = recs.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt);
    return direction === 'desc' ? -cmp : cmp;
  });
  const items = recs.map((r) => pullJsonFresh(repo, r));
  send(res, 200, paginate(req, res, '/api/v3/repos/' + m[1] + '/' + m[2] + '/pulls', query, items));
  return true;
}

export function hGetPull(req, res, m) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const rec = store.getPull(repo, parseInt(m[3], 10));
  if (!rec) {
    notFound(res);
    return true;
  }
  send(res, 200, pullJsonFresh(repo, rec));
  return true;
}
export function hPullFiles(req, res, m) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const rec = store.getPull(repo, parseInt(m[3], 10));
  if (!rec) {
    send(res, 404, { message: 'Not Found' });
    return true;
  }
  const baseTip = rec.baseSha;
  const headTip = rec.headSha;
  const mb = mergeBase(repo, baseTip, headTip);
  const changes = treeDiff(repo, mb ? treeOfCommit(repo, mb) : null, treeOfCommit(repo, headTip));
  const entries = changes.map((ch) => {
    const oldData = ch.oldSha ? getObject(repo, ch.oldSha)?.data ?? null : null;
    const newData = ch.newSha ? getObject(repo, ch.newSha)?.data ?? null : null;
    const counts = diffLineCounts(oldData, newData);
    return {
      sha: ch.newSha,
      filename: ch.path,
      status: ch.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: ''
    };
  });
  send(res, 200, entries);
  return true;
}

export function hMergePull(req, res, m, _q, body) {
  const repo = repoOf(res, m);
  if (repo === true) return true;
  const rec = store.getPull(repo, parseInt(m[3], 10));
  if (!rec) {
    send(res, 404, { message: 'Not Found' });
    return true;
  }
  if (rec.merged || rec.state === 'closed') {
    send(res, 405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  const b = parseBody(body) ?? {};
  const r = doMerge(repo, rec, b.merge_method ?? 'squash', b.commit_title, b.commit_message);
  if ('conflict' in r && r.conflict) {
    send(res, 405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  send(res, 200, { sha: (r as any).sha, merged: true, message: 'Pull Request successfully merged' });
  return true;
}
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const aSet = new Set<string>();
  let queue: string[] = [a];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (aSet.has(sha)) continue;
    aSet.add(sha);
    const commit = parseCommitOf(repo, sha);
    if (commit) {
      queue.push(...commit.parents);
    }
  }
  queue = [b];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (aSet.has(sha)) return sha;
    const commit = parseCommitOf(repo, sha);
    if (commit) {
      queue.push(...commit.parents);
    }
  }
  return null;
}

export function computeMerge(repo: RepoRec, baseTip: string, headTip: string): { conflict: boolean; treeSha?: string } {
  const mb = mergeBase(repo, baseTip, headTip);
  const mbMap = flattenTree(repo, mb ? treeOfCommit(repo, mb) : null);
  const baseMap = flattenTree(repo, treeOfCommit(repo, baseTip));
  const headMap = flattenTree(repo, treeOfCommit(repo, headTip));
  const result = new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...mbMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const mbV = mbMap.get(path)?.sha ?? null;
    const baseV = baseMap.get(path)?.sha ?? null;
    const headV = headMap.get(path)?.sha ?? null;
    let pick: string | null = null;
    if (headV === mbV) {
      pick = baseV;
    } else if (baseV === mbV) {
      pick = headV;
    } else if (baseV === headV) {
      pick = baseV;
    }
    if (pick === null) {
      return { conflict: true };
    }
    result.set(path, { sha: pick, mode: '100644' });
  }
  const treeSha = buildTree(repo, result);
  return { conflict: false, treeSha };
}

export function doMerge(repo: RepoRec, rec: IssueRec, method: string, commitTitle?: string, commitMessage?: string): { sha: string } | { conflict: true } {
  const baseRef = 'refs/heads/' + rec.baseRef;
  const headRef = 'refs/heads/' + rec.headRef;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return { conflict: true };
  const cm = computeMerge(repo, baseTip, headTip);
  if (cm.conflict) return cm;
  const ident = viewerIdent(repo);
  let message: string;
  let data: string;
  if (method === 'merge') {
    message = commitTitle ?? 'Merge pull request #' + rec.number;
    data = formatCommit({ tree: cm.treeSha, parents: [baseTip, headTip], author: ident, committer: ident, message });
  } else {
    message = (commitTitle ?? rec.title + ' (#' + rec.number + ')') + (commitMessage ? '\n\n' + commitMessage : '');
    data = formatCommit({ tree: cm.treeSha, parents: [baseTip], author: ident, committer: ident, message });
  }
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(baseRef, sha);
  repo.updatedAt = nowIso();
  repo.pushedAt = repo.updatedAt;
  rec.merged = true;
  rec.mergedAt = nowIso();
  rec.mergeCommitSha = sha;
  rec.state = 'closed';
  rec.closedAt = rec.mergedAt;
  rec.updatedAt = rec.mergedAt;
  rec.baseSha = baseTip;
  rec.headSha = headTip;
  return { sha };
}

function pullJsonFresh(repo: any, rec: any): any {
  rec.headSha = repo.refs.get('refs/heads/' + rec.headRef) ?? rec.headSha;
  rec.baseSha = repo.refs.get('refs/heads/' + rec.baseRef) ?? rec.baseSha;
  const j: any = pullJson(repo, rec);
  if (!rec.merged) {
    const cm = computeMerge(repo, rec.baseSha, rec.headSha);
    j.mergeable = !cm.conflict;
  } else j.mergeable = false;
  return j;
}

function stripOwner(ref: string): string {
  return ref.includes(':') ? ref.substring(ref.lastIndexOf(':') + 1) : ref;
}
export function handleRest(req: any, res: any, storeRef: any, path: string, query: URLSearchParams, body: Buffer): void {
  const store = storeRef; // prefer the imported store singleton
  let method = req.method ?? 'GET';
  let p = path;
  if (p.length > 7 && p.endsWith('/')) p = p.slice(0, -1);
  function M(owner: string, repo: string, extra: string): any {
    return ['', owner, repo, extra];
  }
  if (p === '/api/v3') {
    hRoot(req, res, M('', '', ''), query, body);
    return;
  }
  if (p === '/api/v3/meta' && method === 'GET') {
    hMeta(req, res, M('', '', ''), query, body);
    return;
  }
  if (p === '/api/v3/rate_limit' && method === 'GET') {
    send(res, 200, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset: 1890000000, used: 1 }
      },
      rate: { limit: 5000, remaining: 4999, reset: 1890000000, used: 1 }
    });
    return;
  }
  if (p === '/api/v3/user' && method === 'GET') {
    hUser(req, res, M('', '', ''), query, body);
    return;
  }
  const uMatch = p.match(/^\/api\/v3\/users\/([^/]+)$/);
  if (uMatch && method === 'GET') {
    const login = decodeURIComponent(uMatch[1]);
    if (login === store.viewer().login) {
      hUser(req, res, M('', '', ''), query, body);
    } else {
      notFound(res);
    }
    return;
  }
  if (p === '/api/v3/user/repos') {
    if (method === 'POST') {
      hCreateRepo(req, res, M('', '', ''), query, body);
    } else if (method === 'GET') {
      hListUserRepos(req, res, M('', '', ''), query, body);
    }
    return;
  }
  const rm = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!rm) {
    notFound(res);
    return;
  }
  const owner = decodeURIComponent(rm[1]);
  const repoName = decodeURIComponent(rm[2]);
  const rest = rm[3] ?? '';
  const mm = M(owner, repoName, '');
  if (rest === '') {
    if (method === 'GET') {
      hRepo(req, res, mm, query, body);
    } else if (method === 'PATCH') {
      hPatchRepo(req, res, mm, query, body);
    } else if (method === 'DELETE') {
      hDeleteRepo(req, res, mm, query, body);
    } else {
      notFound(res);
    }
    return;
  }
  if (rest === '/branches' && method === 'GET') {
    hBranches(req, res, mm, query, body);
    return;
  }
  if (rest.startsWith('/branches/') && method === 'GET') {
    const branch = decodeURIComponent(rest.slice('/branches/'.length));
    hBranch(req, res, M(owner, repoName, branch), query, body);
    return;
  }
  if (rest === '/commits' && method === 'GET') {
    hCommits(req, res, mm, query, body);
    return;
  }
  const cMatch = rest.match(/^\/commits\/([0-9a-f]{40})$/);
  if (cMatch && method === 'GET') {
    const sha = cMatch[1];
    hCommit(req, res, M(owner, repoName, sha), query, body);
    return;
  }
  if (rest === '/git/refs' && method === 'GET') {
    hListRefs(req, res, mm, query, body);
    return;
  }
  if (rest === '/git/refs' && method === 'POST') {
    hCreateRef(req, res, mm, query, body);
    return;
  }
  const grMatch = rest.match(/^\/git\/refs\/(.+)$/);
  if (grMatch && method === 'GET') {
    const ref = decodeURIComponent(grMatch[1]);
    hGetRef(req, res, M(owner, repoName, ref), query, body);
    return;
  }
  if (grMatch && method === 'DELETE') {
    const ref = decodeURIComponent(grMatch[1]);
    hDeleteRef(req, res, M(owner, repoName, ref), query, body);
    return;
  }
  if (rest === '/git/ref/' && method === 'GET') {
    const ref = decodeURIComponent(rest.slice('/git/ref/'.length));
    hGetRef(req, res, M(owner, repoName, ref), query, body);
    return;
  }
  const cmMatch = rest.match(/^\/contents(?:\/(.*))?$/);
  if (cmMatch) {
    const extra = decodeURIComponent(cmMatch[1] ?? '');
    if (method === 'GET') {
      hGetContents(req, res, M(owner, repoName, extra), query, body);
    } else if (method === 'PUT') {
      hPutContents(req, res, M(owner, repoName, extra), query, body);
    } else if (method === 'DELETE') {
      hDeleteContents(req, res, M(owner, repoName, extra), query, body);
    }
    return;
  }
  if (rest === '/issues' && method === 'GET') {
    hListIssues(req, res, mm, query, body);
    return;
  }
  if (rest === '/issues' && method === 'POST') {
    hCreateIssue(req, res, mm, query, body);
    return;
  }
  const iMatch = rest.match(/^\/issues\/(\d+)$/);
  if (iMatch && method === 'GET') {
    const num = iMatch[1];
    hGetIssue(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (iMatch && method === 'PATCH') {
    const num = iMatch[1];
    hPatchIssue(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (rest === '/issues/' && method === 'POST') {
    const num = rest.slice('/issues/'.length);
    hCreateComment(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (rest.startsWith('/issues/') && method === 'POST') {
    const num = rest.slice('/issues/'.length);
    hCreateComment(req, res, M(owner, repoName, num), query, body);
    return;
  }
  const lMatch = rest.match(/^\/labels\/(.+)$/);
  if (lMatch && method === 'GET') {
    const label = decodeURIComponent(lMatch[1]);
    hGetLabel(req, res, M(owner, repoName, label), query, body);
    return;
  }
  if (rest === '/labels' && method === 'GET') {
    hListLabels(req, res, mm, query, body);
    return;
  }
  if (rest === '/labels' && method === 'POST') {
    hCreateLabel(req, res, mm, query, body);
    return;
  }
  if (rest === '/pulls' && method === 'GET') {
    hListPulls(req, res, mm, query, body);
    return;
  }
  if (rest === '/pulls' && method === 'POST') {
    hCreatePull(req, res, mm, query, body);
    return;
  }
  const prMatch = rest.match(/^\/pulls\/(\d+)$/);
  if (prMatch && method === 'GET') {
    const num = prMatch[1];
    hGetPull(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (rest === '/pulls/' && method === 'GET') {
    const num = rest.slice('/pulls/'.length);
    hPullFiles(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (rest.startsWith('/pulls/') && method === 'GET') {
    const num = rest.slice('/pulls/'.length);
    hPullFiles(req, res, M(owner, repoName, num), query, body);
    return;
  }
  if (rest.startsWith('/pulls/') && method === 'PUT') {
    const num = rest.slice('/pulls/'.length);
    hMergePull(req, res, M(owner, repoName, num), query, body);
    return;
  }
  notFound(res);
  return;
}
// END OF rest.ts
