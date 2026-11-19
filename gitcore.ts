 // Verdant Forge — git object/pack engine (original implementation).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj { type: GitObjType; data: Buffer };
export type ObjectDb = { objects: Map<string, GitObj> };

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type: GitObjType, data: Buffer): string {
  const header = `${type} ${data.length}\0`;
  return sha1Hex(Buffer.concat([Buffer.from(header, 'utf8'), data]));
}

export function putObject(db: ObjectDb, type: GitObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!db.objects.has(sha)) {
    db.objects.set(sha, { type, data });
  }
  return sha;
}

export function getObject(db: ObjectDb, sha: string): GitObj | undefined {
  return db.objects.get(sha);
}

export function serializeObject(type: GitObjType, data: Buffer): Buffer {
  const header = `${type} ${data.length}\0`;
  return Buffer.concat([Buffer.from(header, 'utf8'), data]);
}

export interface CommitRec { tree: string; parents: string[]; author: string; committer: string; message: string };

export function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8');
  const parts = text.split('\n\n');
  const message = parts[1] || '';
  let headerLines = parts[0].split('\n');
  let tree = '';
  let parents: string[] = [];
  let author = '';
  let committer = '';
  let current = '';
  for (let line of headerLines) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5);
      current = 'tree';
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
      current = 'parent';
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
      current = 'author';
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      current = 'committer';
    } else if (line.startsWith(' ') && current) {
      if (current === 'author') {
        author += line.slice(1);
      } else if (current === 'committer') {
        committer += line.slice(1);
      }
    }
  }
  return { tree, parents, author, committer, message };
}

export function formatCommit(c: CommitRec): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${c.tree}`);
  for (let p of c.parents) {
    lines.push(`parent ${p}`);
  }
  if (c.author) lines.push(`author ${c.author}`);
  if (c.committer) lines.push(`committer ${c.committer}`);
  const head = lines.join('\n');
  if (c.message === '') {
    return Buffer.from(head + '\n', 'utf8');
  }
  return Buffer.from(head + '\n\n' + c.message, 'utf8');
}
export interface TreeEntry { mode: string; name: string; sha: string };
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    let mode = '';
    while (i < data.length && data[i] !== 0x20) {
      mode += String.fromCharCode(data[i]);
      i++;
    }
    if (i >= data.length) break;
    i++; // skip space
    let name = '';
    while (i < data.length && data[i] !== 0x00) {
      name += String.fromCharCode(data[i]);
      i++;
    }
    if (i >= data.length) break;
    i++; // skip NUL
    if (i + 20 > data.length) break;
    const shaBuf = data.subarray(i, i + 20);
    const sha = shaBuf.toString('hex');
    entries.push({ mode, name, sha });
    i += 20;
  }
  return entries;
}
export function formatTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + ' ' + e.name, 'utf8'));
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface TagRec { object: string; type: string; tag: string; tagger: string; message: string };
export function parseTag(data: Buffer): TagRec {
  const text = data.toString('utf8');
  const parts = text.split('\n\n');
  const message = parts[1] || '';
  let headerLines = parts[0].split('\n');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (let line of headerLines) {
    if (line.startsWith('object ')) {
      object = line.slice(7);
    } else if (line.startsWith('type ')) {
      type = line.slice(5);
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4);
    } else if (line.startsWith('tagger ')) {
      tagger = line.slice(7);
    }
  }
  return { object, type, tag, tagger, message };
}
export function formatTag(t: TagRec): Buffer {
  const lines: string[] = [];
  lines.push(`object ${t.object}`);
  lines.push(`type ${t.type}`);
  lines.push(`tag ${t.tag}`);
  if (t.tagger) lines.push(`tagger ${t.tagger}`);
  const head = lines.join('\n');
  return Buffer.from(head + '\n\n' + t.message, 'utf8');
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  let sourceSize = 0;
  let shift = 0;
  let b;
  do {
    b = delta[pos++];
    sourceSize |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  if (sourceSize !== base.length) {
    throw new Error(`Delta source size mismatch: expected ${base.length}, got ${sourceSize}`);
  }
  let targetSize = 0;
  shift = 0;
  do {
    b = delta[pos++];
    targetSize |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  let result = Buffer.alloc(targetSize);
  let resultPos = 0;
  while (pos < delta.length) {
    let op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      shift = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          let byte = delta[pos++];
          offset |= byte << shift;
          shift += 8;
        }
      }
      let size = 0;
      shift = 0;
      for (let i = 4; i < 7; i++) {
        if (op & (1 << i)) {
          let byte = delta[pos++];
          size |= byte << shift;
          shift += 8;
        }
      }
      if (size === 0) size = 0x10000;
      let copyData = base.subarray(offset, offset + size);
      copyData.copy(result, resultPos);
      resultPos += copyData.length;
    } else if (op !== 0) {
      let data = delta.slice(pos, pos + op);
      data.copy(result, resultPos);
      resultPos += data.length;
      pos += op;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }
  if (resultPos !== targetSize) {
    throw new Error(`Delta target size mismatch: expected ${targetSize}, got ${resultPos}`);
  }
  return result;
}
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, GitObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function encodeObjHeader(typeCode: number, size: number): Buffer {
  let rest = size >> 4;
  let first = (typeCode << 4) | (size & 0x0f);
  if (rest > 0) first |= 0x80;
  const bytes: number[] = [first];
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
export function buildPack(db: ObjectDb, shas: string[]): Buffer {
  const uniqueShas = [...new Set(shas)];
  const included = uniqueShas.filter(sha => db.objects.has(sha));
  const objectData: Buffer[] = [];
  for (const sha of included) {
    const obj = db.objects.get(sha)!;
    const typeCode = TYPE_CODES[obj.type];
    const headerBuf = encodeObjHeader(typeCode, obj.data.length);
    const compressed = deflateSync(obj.data);
    objectData.push(Buffer.concat([headerBuf, compressed]));
  }
  const objectBytes = Buffer.concat(objectData);
  const versionBuf = Buffer.alloc(4);
  versionBuf.writeUInt32BE(2, 0);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(included.length, 0);
  const header = Buffer.concat([
    Buffer.from('PACK'),
    versionBuf,
    countBuf
  ]);
  const trailer = createHash('sha1').update(Buffer.concat([header, objectBytes])).digest();
  return Buffer.concat([header, objectBytes, trailer]);
}
export function parsePack(db: ObjectDb, pack: Buffer): string[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('invalid pack file');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2) {
    throw new Error('unsupported pack version');
  }
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (computed !== pack.subarray(trailerStart).toString('hex')) {
    throw new Error('pack checksum mismatch');
  }
  const byStart = new Map<number, { type: GitObjType; data: Buffer }>();
  const shas: string[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const objStart = offset;
    let b = pack[offset++];
    let typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseStart = -1;
    let baseShaHex = '';
    if (typeCode === 6) {
      let off = pack[offset++];
      let val = off & 0x7f;
      while (off & 0x80) {
        off = pack[offset++];
        val = ((val + 1) << 7) | (off & 0x7f);
      }
      baseStart = objStart - val;
    } else if (typeCode === 7) {
      baseShaHex = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    let lo = 1;
    let hi = pack.length - offset;
    let data: Buffer | null = null;
    let consumed = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const out = inflateSync(pack.subarray(offset, offset + mid));
        data = out;
        consumed = mid;
        hi = mid - 1;
      } catch (e) {
        lo = mid + 1;
      }
    }
    if (data === null) {
      throw new Error('inflate failed');
    }
    let type: GitObjType;
    if (typeCode === 6 || typeCode === 7) {
      let base: { type: GitObjType; data: Buffer } | undefined;
      if (typeCode === 6) {
        base = byStart.get(baseStart);
      } else {
        base = db.objects.get(baseShaHex) ?? byStart.get(-1);
        if (!base) {
          for (const v of byStart.values()) {
            if (hashObject(v.type, v.data) === baseShaHex) { base = v; break; }
          }
        }
      }
      if (!base) {
        throw new Error('delta base not found');
      }
      type = base.type;
      data = applyDelta(base.data, data);
    } else {
      type = CODE_TYPES[typeCode];
    }
    const sha = hashObject(type, data);
    db.objects.set(sha, { type, data });
    byStart.set(objStart, { type, data });
    shas.push(sha);
    offset += consumed;
  }
  return shas;
}

export function pktLine(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const total = body.length + 4;
  if (total > 65520) throw new Error('pkt-line too long');
  const prefix = total.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem = Buffer | 'flush' | 'delim' | 'response-end';

export function readPktLines(buf: Buffer, offset?: number): { lines: PktItem[]; nextOffset: number } {
  let pos = offset ?? 0;
  const lines: PktItem[] = [];
  while (pos + 4 <= buf.length) {
    const lenStr = buf.toString('ascii', pos, pos + 4);
    let len = parseInt(lenStr, 16);
    if (isNaN(len)) {
      throw new Error('bad pkt-line length');
    }
    if (len === 0) {
      lines.push('flush');
      pos += 4;
      break;
    } else if (len === 1) {
      lines.push('delim');
      pos += 4;
    } else if (len === 2) {
      lines.push('response-end');
      pos += 4;
    } else if (len === 3) {
      throw new Error('bad pkt-line length');
    } else {
      const payloadEnd = pos + len;
      if (payloadEnd > buf.length) {
        throw new Error('bad pkt-line length');
      }
      const payload = buf.subarray(pos + 4, payloadEnd);
      lines.push(payload);
      pos = payloadEnd;
    }
  }
  return { lines, nextOffset: pos };
}
export function commitAncestors(db: ObjectDb, start: string, stopAt: Set<string>): Set<string> {
  const queue: string[] = [start];
  const visited = new Set<string>();
  visited.add(start);
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (stopAt.has(sha)) {
      continue;
    }
    const obj = getObject(db, sha);
    if (!obj || obj.type !== 'commit') {
      continue;
    }
    const rec = parseCommit(obj.data);
    for (let p of rec.parents) {
      if (!visited.has(p)) {
        queue.push(p);
        visited.add(p);
      }
    }
  }
  return visited;
}

export function treeClosure(db: ObjectDb, treeSha: string, into: Set<string>): void {
  const queue: string[] = [treeSha];
  const visited = new Set<string>();
  visited.add(treeSha);
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    const obj = getObject(db, sha);
    if (!obj) continue;
    if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (let e of entries) {
        if (!visited.has(e.sha)) {
          queue.push(e.sha);
          visited.add(e.sha);
          into.add(e.sha);
        }
      }
    } else if (obj.type === 'blob' || obj.type === 'tag') {
      into.add(sha);
    }
  }
}

export function isAncestor(db: ObjectDb, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const visited = new Set<string>();
  const queue: string[] = [desc];
  visited.add(desc);
  while (queue.length > 0) {
    const sha = queue.shift()!;
    const obj = getObject(db, sha);
    if (!obj || obj.type !== 'commit') continue;
    const rec = parseCommit(obj.data);
    for (let p of rec.parents) {
      if (p === anc) return true;
      if (!visited.has(p)) {
        queue.push(p);
        visited.add(p);
      }
    }
  }
  return false;
}

export function collectObjects(db: ObjectDb, wants: string[], haves: ReadonlySet<string>, opts?: { depth?: number }): { shas: string[]; shallowBoundary: string[] } {
  function peelToCommit(sha: string): string | null {
    let cur = sha;
    for (let i = 0; i < 16; i++) {
      const obj = getObject(db, cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
      return null;
    }
    return null;
  }
  function addTreeClosure(treeSha: string, into: Set<string>): void {
    if (into.has(treeSha)) return;
    const obj = getObject(db, treeSha);
    if (!obj || obj.type !== 'tree') return;
    into.add(treeSha);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') addTreeClosure(e.sha, into);
      else into.add(e.sha);
    }
  }
  const excludedCommits = new Set<string>();
  const stack: string[] = [];
  for (const h of haves) { const c = peelToCommit(h); if (c && !excludedCommits.has(c)) { excludedCommits.add(c); stack.push(c); } }
  while (stack.length > 0) {
    const c = stack.pop()!;
    const obj = getObject(db, c);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!excludedCommits.has(p)) { excludedCommits.add(p); stack.push(p); }
    }
  }
  const excluded = new Set<string>(excludedCommits);
  for (const c of excludedCommits) {
    const obj = getObject(db, c);
    if (obj && obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree, excluded);
  }
  const included = new Set<string>();
  const shallowBoundary: string[] = [];
  const depth = opts?.depth;
  const queue: { sha: string; gen: number }[] = wants.map((w) => ({ sha: w, gen: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    let cur = item.sha;
    for (let i = 0; i < 16; i++) {
      const obj = getObject(db, cur);
      if (!obj) break;
      if (obj.type === 'tag') { if (!excluded.has(cur)) included.add(cur); cur = parseTag(obj.data).object; continue; }
      if (obj.type === 'tree') { if (!excluded.has(cur)) addTreeClosure(cur, included); }
      if (obj.type === 'blob') { if (!excluded.has(cur)) included.add(cur); }
      break;
    }
    const commitSha = peelToCommit(item.sha);
    if (!commitSha) continue;
    if (excludedCommits.has(commitSha) || seenCommits.has(commitSha)) continue;
    seenCommits.add(commitSha);
    included.add(commitSha);
    const cobj = getObject(db, commitSha);
    if (!cobj || cobj.type !== 'commit') continue;
    const rec = parseCommit(cobj.data);
    const tc = new Set<string>();
    addTreeClosure(rec.tree, tc);
    for (const s of tc) { if (!excluded.has(s)) included.add(s); }
    const gen = item.gen;
    if (depth !== undefined && gen + 1 >= depth) {
      const hasOutsideParent = rec.parents.some((p) => !excludedCommits.has(p));
      if (hasOutsideParent && !shallowBoundary.includes(commitSha)) shallowBoundary.push(commitSha);
      continue;
    }
    for (const p of rec.parents) {
      if (!excludedCommits.has(p) && !seenCommits.has(p)) queue.push({ sha: p, gen: gen + 1 });
    }
  }
  const shas = Array.from(included).filter((s) => !excluded.has(s) || included.has(s) && !excludedCommits.has(s));
  return { shas: Array.from(included), shallowBoundary };
}

export function flatten(db: ObjectDb, treeSha: string | null, prefix: string, into: Map<string, string>): void {
  if (treeSha === null) return;
  const obj = db.objects.get(treeSha);
  if (!obj) return;
  if (obj.type !== 'tree') return;
  const entries = parseTree(obj.data);
  for (let entry of entries) {
    const full = prefix + entry.name;
    if (entry.mode === '40000') {
      flatten(db, entry.sha, full + '/', into);
    } else {
      into.set(full, entry.sha);
    }
  }
}
export function treeDiff(db: ObjectDb, baseTree: string | null, headTree: string | null): TreeChange[] {
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  flatten(db, baseTree, '', baseMap);
  flatten(db, headTree, '', headMap);
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const changes: TreeChange[] = [];
  for (let path of Array.from(paths).sort()) {
    const oldSha = baseMap.get(path) || null;
    const newSha = headMap.get(path) || null;
    if (oldSha === null && newSha === null) continue;
    if (oldSha !== null && newSha !== null && oldSha === newSha) continue;
    changes.push({ path, status: oldSha === null ? 'added' : newSha === null ? 'removed' : 'modified', oldSha, newSha });
  }
  return changes;
}
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0A) count++;
  }
  return count;
}
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData ? oldData.toString('utf8').split('\n').filter(l => l !== '') : [];
  const newLines = newData ? newData.toString('utf8').split('\n').filter(l => l !== '') : [];
  const maxLines = 2000;
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    if (oldData !== null && newData !== null && oldData.equals(newData)) {
      return { additions: 0, deletions: 0 };
    }
    return { additions: newLines.length, deletions: oldLines.length };
  }
  let dp = new Array(oldLines.length + 1).fill(0).map(() => new Array(newLines.length + 1).fill(0));
  for (let i = 0; i <= oldLines.length; i++) {
    for (let j = 0; j <= newLines.length; j++) {
      if (i === 0 || j === 0) {
        dp[i][j] = 0;
      } else if (oldLines[i-1] === newLines[j-1]) {
        dp[i][j] = dp[i-1][j-1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
  }
  const lcs = dp[oldLines.length][newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}
// END OF gitcore.ts
