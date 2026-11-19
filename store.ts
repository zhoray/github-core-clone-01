// Verdant Forge — shared in-memory state (original implementation).
export type GitObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj { type: GitObjType; data: Buffer };
export interface LabelRec { id: number; name: string; color: string; description: string };
export interface CommentRec { id: number; body: string; createdAt: string; updatedAt: string };
export interface IssueRec { number: number; id: number; kind: 'issue' | 'pull'; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: CommentRec[]; createdAt: string; updatedAt: string; closedAt: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null };
export interface RepoRec { id: number; name: string; ownerLogin: string | null; private: boolean; description: string; defaultBranch: string; createdAt: string; updatedAt: string; pushedAt: string; nextNumber: number; labels: Map<string, LabelRec>; issues: Map<number, IssueRec>; objects: Map<string, GitObj>; refs: Map<string, string>; headRef: string; shallow: Set<string> };
let lastMs = 0;
export function nowIso(): string {
  let t = Math.max(Date.now(), lastMs + 1);
  lastMs = t;
  return new Date(t).toISOString();
}
export function nowUnix(): number {
  let t = Math.max(Date.now(), lastMs + 1);
  lastMs = t;
  return Math.floor(t / 1000);
}
export function nodeId(kind: string, dbId: number): string {
  return Buffer.from(kind + ':' + dbId, 'utf8').toString('base64');
}
export function parseNodeId(s: string): { kind: string; id: number } | null {
  let buf;
  try {
    buf = Buffer.from(s, 'base64');
  } catch {
    return null;
  }
  let parts = buf.toString('utf8').split(':');
  if (parts.length !== 2) {
    return null;
  }
  let [kind, idStr] = parts;
  let id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return null;
  }
  return { kind, id };
}
const DEFAULT_LABELS: [string, string][] = [['bug','d73a4a'],['documentation','0075ca'],['duplicate','cfd3d7'],['enhancement','a2eeef'],['good first issue','7057ff'],['help wanted','008672'],['invalid','e4e669'],['question','d876e3'],['wontfix','ffffff']];
export class ForgeStore {
  private viewerName: string | null = null;
  private reposByName = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  adoptViewer(login: string): void {
    if (this.viewerName === null && login !== '') {
      this.viewerName = login;
      for (const repo of this.reposByName.values()) {
        repo.ownerLogin = login;
      }
    }
  }
  viewerLogin(): string | null {
    return this.viewerName;
  }
  viewer(): { id: number; login: string; name: string; email: string } {
    const login = this.viewerName ?? 'viewer';
    return { id: 1000, login, name: login, email: login + '@example.invalid' };
  }
  createRepo(input: { name: string; private?: boolean; description?: string; defaultBranch?: string }): RepoRec {
    this.repoSeq++;
    const ts = nowIso();
    const defaultBranch = input.defaultBranch ?? 'main';
    const labels = new Map<string, LabelRec>();
    for (const [name, color] of DEFAULT_LABELS) {
      labels.set(name, { id: ++this.labelSeq, name, color, description: '' });
    }
    const rec: RepoRec = {
      id: this.repoSeq,
      name: input.name,
      ownerLogin: this.viewerName,
      private: input.private ?? false,
      description: input.description ?? '',
      defaultBranch,
      createdAt: ts,
      updatedAt: ts,
      pushedAt: ts,
      nextNumber: 1,
      labels,
      issues: new Map(),
      objects: new Map(),
      refs: new Map(),
      headRef: 'refs/heads/' + defaultBranch,
      shallow: new Set()
    };
    this.reposByName.set(input.name, rec);
    return rec;
  }
  getRepoByName(name: string): RepoRec | undefined {
    return this.reposByName.get(name);
  }
  getRepo(owner: string, name: string): RepoRec | null {
    const rec = this.reposByName.get(name);
    if (!rec) {
      return null;
    }
    if (this.viewerName !== null && owner !== this.viewerName) {
      return null;
    }
    return rec;
  }
  listRepos(): RepoRec[] {
    return Array.from(this.reposByName.values());
  }
  deleteRepo(owner: string, name: string): boolean {
    const rec = this.getRepo(owner, name);
    if (rec) {
      this.reposByName.delete(name);
      return true;
    }
    return false;
  }
  repoCount(): number {
    return this.reposByName.size;
  }
  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const now = nowIso();
    const number = repo.nextNumber++;
    const id = ++this.issueSeq;
    const rec: IssueRec = {
      id,
      number,
      kind: 'issue',
      state: 'open',
      title: input.title,
      body: input.body ?? '',
      labels: input.labels ?? [],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      headRef: '',
      baseRef: '',
      headSha: '',
      baseSha: '',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.issues.set(number, rec);
    return rec;
  }
  createPull(repo: RepoRec, input: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string }): IssueRec {
    const now = nowIso();
    const number = repo.nextNumber++;
    const id = ++this.issueSeq;
    const rec: IssueRec = {
      id,
      number,
      kind: 'pull',
      state: 'open',
      title: input.title,
      body: input.body ?? '',
      labels: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha: input.headSha,
      baseSha: input.baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.issues.set(number, rec);
    return rec;
  }
  getIssue(repo: RepoRec, n: number): IssueRec | undefined {
    return repo.issues.get(n);
  }
  getPull(repo: RepoRec, n: number): IssueRec | undefined {
    const rec = repo.issues.get(n);
    return rec && rec.kind === 'pull' ? rec : undefined;
  }
  listIssuesOnly(repo: RepoRec): IssueRec[] {
    return Array.from(repo.issues.values())
      .filter((r) => r.kind === 'issue')
      .sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  listPullsOnly(repo: RepoRec): IssueRec[] {
    return Array.from(repo.issues.values())
      .filter((r) => r.kind === 'pull')
      .sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  addComment(repo: RepoRec, n: number, body: string): CommentRec | undefined {
    const rec = repo.issues.get(n);
    if (!rec) return undefined;
    const now = nowIso();
    const id = ++this.commentSeq;
    const comment: CommentRec = {
      id,
      body,
      createdAt: now,
      updatedAt: now,
    };
    rec.comments.push(comment);
    rec.updatedAt = now;
    return comment;
  }
  listLabels(repo: RepoRec): LabelRec[] {
    return Array.from(repo.labels.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
  createLabel(repo: RepoRec, input: { name: string; color?: string; description?: string }): LabelRec {
    const id = ++this.labelSeq;
    const color = input.color?.replace(/^#/, '') ?? 'ededed';
    const description = input.description ?? '';
    const rec: LabelRec = {
      id,
      name: input.name,
      color,
      description,
    };
    repo.labels.set(input.name, rec);
    return rec;
  }
  getLabel(repo: RepoRec, name: string): LabelRec | undefined {
    return repo.labels.get(name);
  }
}
export const store = new ForgeStore();
// END OF store.ts

// store-brace-fix
