// Verdant Forge — REST v3 JSON shapes (original implementation).
import { store, nodeId } from './store.ts';
import type { RepoRec, LabelRec, IssueRec, CommentRec } from './store.ts';
function ownerOf(): string {
  return store.viewerLogin() ?? 'viewer';
}
export function userJson(u: { id: number; login: string; name: string; email: string }) {
  return {
    login: u.login,
    id: u.id,
    node_id: nodeId('User', u.id),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/users/' + u.login,
    html_url: '',
    type: 'User',
    site_admin: false,
    name: u.name,
    email: u.email
  };
}
export function repoJson(repo: RepoRec) {
  const owner = ownerOf();
  const openIssuesCount = Array.from(repo.issues.values()).filter((i: any) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: owner + '/' + repo.name,
    private: repo.private,
    owner: userJson(store.viewer()),
    html_url: '',
    description: repo.description,
    fork: false,
    url: '/api/v3/repos/' + owner + '/' + repo.name,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    forks_count: 0,
    open_issues_count: openIssuesCount,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: {
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true
    }
  };
}
export function labelJson(l: LabelRec) {
  return {
    id: l.id,
    node_id: nodeId('Label', l.id),
    url: '',
    name: l.name,
    color: l.color,
    default: true,
    description: l.description
  };
}
export function issueJson(repo: RepoRec, rec: IssueRec): any {
  const owner = ownerOf();
  return {
    id: rec.id,
    node_id: nodeId(rec.kind === 'pull' ? 'PullRequest' : 'Issue', rec.id),
    url: '/api/v3/repos/' + owner + '/' + repo.name + '/issues/' + rec.number,
    repository_url: '/api/v3/repos/' + owner + '/' + repo.name,
    number: rec.number,
    title: rec.title,
    user: userJson(store.viewer()),
    labels: rec.labels.map((n) => repo.labels.get(n)).filter((x) => x !== undefined).map((l) => labelJson(l)),
    state: rec.state,
    locked: false,
    comments: rec.comments.length,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    closed_at: rec.closedAt,
    body: rec.body
  };
}

export function pullJson(repo: RepoRec, rec: IssueRec) {
  const owner = ownerOf();
  return Object.assign(issueJson(repo, rec), {
    head: {
      label: owner + ':' + rec.headRef,
      ref: rec.headRef,
      sha: rec.headSha,
      user: userJson(store.viewer()),
      repo: repoJson(repo)
    },
    base: {
      label: owner + ':' + rec.baseRef,
      ref: rec.baseRef,
      sha: rec.baseSha,
      user: userJson(store.viewer()),
      repo: repoJson(repo)
    },
    merged: rec.merged,
    merged_at: rec.mergedAt,
    merge_commit_sha: rec.mergeCommitSha,
    draft: false,
    merged_by: rec.merged ? userJson(store.viewer()) : null
  });
}

export function commentJson(repo: RepoRec, rec: IssueRec, c: CommentRec) {
  const owner = ownerOf();
  return {
    id: c.id,
    node_id: nodeId('IssueComment', c.id),
    url: '/api/v3/repos/' + owner + '/' + repo.name + '/issues/comments/' + c.id,
    html_url: '',
    body: c.body,
    user: userJson(store.viewer()),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    issue_url: '/api/v3/repos/' + owner + '/' + repo.name + '/issues/' + rec.number
  };
}

export function branchJson(repo: RepoRec, name: string, sha: string) {
  const owner = ownerOf();
  return {
    name,
    commit: {
      sha,
      url: ''
    },
    protected: false
  };
}

// END OF shapes.ts
