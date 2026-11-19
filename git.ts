 // Verdant Forge — git smart-HTTP protocol (original implementation).
import { getObject, putObject, parseCommit, parseTree, parseTag, buildPack, parsePack, pktLine, pktFlush, pktDelim, readPktLines, collectObjects, isAncestor } from './gitcore.ts';
import type { GitObj, ObjectDb } from './gitcore.ts';
import type { RepoRec } from './store.ts';

export const ZERO = '0000000000000000000000000000000000000000';

export function reqId(): string {
  return Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('');
}

export function sendJson(res: any, status: number, obj: any): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function sortedRefs(repo: RepoRec): [string, string][] {
  return Array.from(repo.refs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

export function peelTag(db: ObjectDb, sha: string): string {
  let current = sha;
  while (true) {
    const obj = getObject(db, current);
    if (!obj || obj.type !== 'tag') {
      return current;
    }
    const tag = parseTag(obj.data);
    current = tag.object;
  }
}

export function handleAdvertise(req: any, res: any, repo: RepoRec, service: string): void {
  res.writeHead(200, { 'content-type': 'application/x-' + service + '-advertisement' });
  const isV2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] || '').includes('version=2');
  const caps = service === 'git-upload-pack'
    ? 'multi_ack_detailed no-done side-band-64k ofs-delta deepen-since deepen-not shallow object-format=sha1 agent=verdant-forge/1.0'
    : 'report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1 agent=verdant-forge/1.0';
  const parts: Buffer[] = [pktLine('# service=' + service + '\n'), pktFlush()];
  if (isV2) {
    parts.push(pktLine('version 2'));
    parts.push(pktLine('agent=verdant-forge/1.0'));
    parts.push(pktLine('ls-refs=unborn'));
    parts.push(pktLine('fetch=filter shallow wait-for-done'));
    parts.push(pktLine('server-option'));
    parts.push(pktLine('object-format=sha1'));
    parts.push(pktFlush());
    res.end(Buffer.concat(parts));
    return;
  }
  if (repo.refs.size === 0) {
    parts.push(pktLine(ZERO + ' capabilities^{}' + '\0' + caps));
  } else {
    const headSha = repo.refs.get(repo.headRef) ?? ZERO;
    const headPayload = headSha + ' HEAD' + '\0' + caps;
    parts.push(pktLine(headPayload));
    for (const [name, sha] of sortedRefs(repo)) {
      const line = sha + ' ' + name;
      parts.push(pktLine(line));
      const obj = getObject(repo, sha);
      if (obj && obj.type === 'tag') {
        const peeled = peelTag(repo, sha);
        parts.push(pktLine(peeled + ' ' + name + '^{}'));
      }
    }
  }
  parts.push(pktFlush());
  res.end(Buffer.concat(parts));
}
export function handleLsRefs(res: any, repo: RepoRec, argLines: Buffer[]): void {
  const parts: Buffer[] = [];
  let symrefs = false;
  let peel = false;
  let unborn = false;
  let prefixes: string[] = [];
  for (const line of argLines) {
    let text = line.toString('utf8').trimEnd('\n');
    if (text === 'symrefs') {
      symrefs = true;
    } else if (text === 'peel') {
      peel = true;
    } else if (text === 'unborn') {
      unborn = true;
    } else if (text.startsWith('ref-prefix ')) {
      prefixes.push(text.slice(11));
    }
  }
  if (symrefs) {
    const headSha = repo.refs.get(repo.headRef);
    if (headSha !== undefined) {
      parts.push(pktLine(headSha + ' HEAD symref-target:' + repo.headRef));
    } else if (unborn) {
      parts.push(pktLine('unborn HEAD symref-target:' + repo.headRef));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (prefixes.length > 0) {
      let hasPrefix = false;
      for (const p of prefixes) {
        if (name.startsWith(p)) {
          hasPrefix = true;
          break;
        }
      }
      if (!hasPrefix) continue;
    }
    let line = sha + ' ' + name;
    if (peel) {
      const obj = getObject(repo, sha);
      if (obj && obj.type === 'tag') {
        line += ' peeled:' + parseTag(obj.data).object;
      }
    }
    parts.push(pktLine(line));
  }
  parts.push(pktFlush());
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'x-github-request-id': reqId()
  });
  res.end(Buffer.concat(parts));
}
export function handleUploadPack(req: any, res: any, repo: RepoRec, body: Buffer): void {
  const parsed = readPktLines(body, 0);
  const items = parsed.lines;
  const helper = (item: Buffer): string => item.toString('utf8').trimEnd('\n');
  const isV2 = items.length > 0 && helper(items[0]).startsWith('command=');
  if (isV2) {
    const sections: string[][] = [];
    let current: string[] = [];
    let delimFound = false;
    for (const line of items) {
      const text = helper(line);
      if (text === 'delim') {
        delimFound = true;
        sections.push(current);
        current = [];
        continue;
      }
      current.push(text);
    }
    sections.push(current);
    const section0 = sections[0];
    if (!section0 || section0.length === 0) {
      return;
    }
    let command = '';
    let capabilities: string[] = [];
    for (const line of section0) {
      if (line.startsWith('command=')) {
        command = line.slice(8);
      } else if (line.includes('=') && line.includes(' ')) {
        capabilities.push(line);
      }
    }
    if (command === 'ls-refs') {
      handleLsRefs(res, repo, (sections[1] ?? []).map((t) => Buffer.from(t + '\n')));
      return;
    }
    if (command === 'fetch') {
      let wants: string[] = [];
      let haves: string[] = [];
      let shallowLines: string[] = [];
      let deepen: number | undefined;
      for (const line of sections[1] || []) {
        if (line.startsWith('want ')) {
          wants.push(line.slice(5));
        } else if (line.startsWith('have ')) {
          haves.push(line.slice(5));
        } else if (line.startsWith('shallow ')) {
          shallowLines.push(line.slice(8));
        } else if (line.startsWith('deepen ')) {
          deepen = parseInt(line.slice(7));
        }
      }
      const r = computeFetch(repo, wants, haves, shallowLines, deepen);
      let nothingNew = r.shas.length === 0 && !r.boundaryChanged;
      const parts: Buffer[] = [];
      const needAck = haves.length > 0 || shallowLines.length > 0;
      if (needAck) {
        parts.push(pktLine('acknowledgments'));
        for (const have of haves) {
          const obj = getObject(repo, have);
          if (obj && obj.type === 'commit') {
            parts.push(pktLine('ACK ' + have + ' common'));
          }
        }
        if (nothingNew && needAck) {
          parts.push(pktLine('ready'));
          parts.push(pktFlush());
          const combined = Buffer.concat(parts);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': reqId() });
          res.end(combined);
          return;
        }
        parts.push(pktDelim());
      }
      if (r.boundaryChanged) {
        parts.push(pktLine('shallow-info'));
        for (const b of r.newBoundary) {
          parts.push(pktLine('shallow ' + b));
        }
        for (const old of shallowLines) {
          if (!r.newBoundary.includes(old)) {
            parts.push(pktLine('unshallow ' + old));
          }
        }
        parts.push(pktDelim());
      }
      parts.push(pktLine('packfile'));
      const pack = buildPack(repo, r.shas);
      const chunkSize = 32768;
      for (let i = 0; i < pack.length; i += chunkSize) {
        const slice = pack.slice(i, i + chunkSize);
        const sideband = Buffer.concat([Buffer.from([1]), slice]);
        parts.push(pktLine(sideband));
      }
      parts.push(pktFlush());
      const combined = Buffer.concat(parts);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': reqId() });
      res.end(combined);
      return;
    }
  } else {
    let wants: string[] = [];
    let haves: string[] = [];
    let shallowLines: string[] = [];
    let deepen: number | undefined;
    for (const line of items) {
      const text = helper(line);
      if (text.startsWith('want ')) {
        wants.push(text.slice(5));
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5));
      } else if (text.startsWith('shallow ')) {
        shallowLines.push(text.slice(8));
      } else if (text.startsWith('deepen ')) {
        deepen = parseInt(text.slice(7));
      }
    }
    const r = computeFetch(repo, wants, haves, shallowLines, deepen);
    const parts: Buffer[] = [];
    if (deepen !== undefined) {
      for (const b of r.newBoundary) {
        parts.push(pktLine('shallow ' + b + '\n'));
      }
    }
    if (r.shas.length === 0) {
      const ackSha = wants[0] ?? ZERO;
      parts.push(pktLine('ACK ' + ackSha + '\n'));
      parts.push(pktFlush());
      const combined = Buffer.concat(parts);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': reqId() });
      res.end(combined);
      return;
    }
    const common = haves.filter((h) => getObject(repo, h)?.type === 'commit');
    parts.push(pktLine(common.length ? 'ACK ' + common[common.length - 1] + '\n' : 'NAK\n'));
    const chunkSize = 32768;
    const pack = buildPack(repo, r.shas);
    for (let i = 0; i < pack.length; i += chunkSize) {
      const slice = pack.slice(i, i + chunkSize);
      const sideband = Buffer.concat([Buffer.from([1]), slice]);
      parts.push(pktLine(sideband));
    }
    parts.push(pktFlush());
    const combined = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': reqId() });
    res.end(combined);
    return;
  }
}
export function computeFetch(repo: RepoRec, wants: string[], haves: string[], shallowLines: string[], deepen: number | undefined): { shas: string[]; newBoundary: string[]; boundaryChanged: boolean } {
  const exclusion = new Set([...haves, ...shallowLines]);
  if (deepen !== undefined) {
    const r = collectObjects(repo, wants, new Set(haves), { depth: deepen });
    return { shas: r.shas, newBoundary: r.shallowBoundary, boundaryChanged: true };
  } else {
    const r = collectObjects(repo, wants, exclusion, {});
    return { shas: r.shas, newBoundary: [], boundaryChanged: false };
  }
}
export function handleReceivePack(res: any, repo: RepoRec, body: Buffer): void {
  let parsed;
  try {
    parsed = readPktLines(body, 0);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }
  const lines = parsed.lines;
  const helper = (item: Buffer): string => item.toString('utf8').trimEnd('\n');
  let commands: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    let text = helper(lines[i]);
    if (text === 'flush') break;
    if (text === 'delim') continue;
    let capIdx = text.indexOf('\0');
    if (capIdx > 0) text = text.slice(0, capIdx);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  const rest = body.subarray(parsed.nextOffset);
  let unpackOk = true;
  let unpackErr = '';
  if (rest.length > 0) {
    try {
      parsePack(repo, rest);
    } catch (e) {
      unpackOk = false;
      unpackErr = 'unpacker error';
    }
  }
  let okStates: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  const refs = new Map(repo.refs);
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      ok = false;
      reason = 'unpacker error';
    } else if (!cmd.ref.startsWith('refs/')) {
      ok = false;
      reason = 'invalid ref';
    } else if (cmd.newSha === ZERO) {
      if (refs.has(cmd.ref)) {
        refs.delete(cmd.ref);
        ok = true;
      } else {
        reason = 'reference not found';
      }
    } else if (cmd.oldSha === ZERO) {
      if (refs.has(cmd.ref)) {
        reason = 'reference already exists';
      } else if (!getObject(repo, cmd.newSha)) {
        reason = 'new object not found';
      } else {
        refs.set(cmd.ref, cmd.newSha);
        ok = true;
      }
    } else {
      if (refs.get(cmd.ref) !== cmd.oldSha) {
        reason = 'reference is not updated';
      } else if (!getObject(repo, cmd.newSha)) {
        reason = 'object not found';
      } else if (!isAncestor(repo, cmd.oldSha, cmd.newSha)) {
        reason = 'non-fast-forward';
      } else {
        refs.set(cmd.ref, cmd.newSha);
        ok = true;
      }
    }
    okStates.push({ ref: cmd.ref, ok, reason });
  }
  repo.refs.clear();
  for (const [k, v] of refs) {
    repo.refs.set(k, v);
  }
  const linesToSend: string[] = ['unpack ' + (unpackOk ? 'ok' : unpackErr)];
  for (const st of okStates) {
    linesToSend.push(st.ok ? 'ok ' + st.ref : 'ng ' + st.ref + ' ' + st.reason);
  }
  const parts: Buffer[] = [];
  for (const L of linesToSend) {
    const inner = pktLine(L + '\n');
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktFlush()])));
  parts.push(pktFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': reqId() });
  res.end(Buffer.concat(parts));
}
export function handleGit(req: any, res: any, store: any, owner: string, repoName: string, service: string, query: URLSearchParams, body: Buffer): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    if (service === 'info/refs') {
      const svc = query.get('service');
      if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Invalid service' });
        return;
      }
      handleAdvertise(req, res, repo, svc);
      return;
    }
    if (service === 'git-upload-pack') {
      handleUploadPack(req, res, repo, body);
      return;
    }
    if (service === 'git-receive-pack') {
      handleReceivePack(res, repo, body);
      return;
    }
    sendJson(res, 400, { message: 'Invalid service' });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 400, { message: 'Bad Request' });
    }
  }
}
// END OF git.ts
