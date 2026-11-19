 // Verdant Forge — HTTP shell (original implementation).
import { createServer as createHttpServer } from 'node:http';
import { store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { randomBytes } from 'node:crypto';
function rid(): string {
  return randomBytes(10).toString('hex').toUpperCase();
}
function json(res: any, status: number, obj: any): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
export function createServer(_ignored?: unknown): any {
  return createHttpServer((req: any, res: any) => {
    res.setHeader('x-github-request-id', rid());
    let bodyChunks: Buffer[] = [];
    const route = (req: any, res: any, body: Buffer): void => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz') {
        if (req.method === 'HEAD') {
          res.writeHead(200);
          res.end();
        } else {
          json(res, 200, { ok: true });
        }
        return;
      }
      const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const auth = req.headers.authorization ?? '';
      const ok = token ? auth === 'Bearer ' + token : auth.startsWith('Bearer ');
      if (!ok) {
        json(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        handleRest(req, res, store, path, url.searchParams, body);
      } else if (path === '/api/graphql') {
        handleGraphQL(req, res, store, body);
      } else if (path === '/mcp') {
        handleMcp(req, res, store, body);
      } else {
        const gm = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gm) {
          const owner = decodeURIComponent(gm[1]);
          const repoName = decodeURIComponent(gm[2]);
          store.adoptViewer(owner);
          handleGit(req, res, store, owner, repoName, gm[3], url.searchParams, body);
          return;
        }
        if (path.match(/^\/([^/]+)\/([^/]+)\.git$/)) {
          json(res, 404, { message: 'Not Found' });
        } else {
          json(res, 404, { message: 'Not Found' });
        }
      }
    };
    req.on('data', (chunk: Buffer) => {
      bodyChunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      try {
        route(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          json(res, 500, { message: 'Internal error' });
        }
      }
    });
  });
}
export function createApp(): any {
  return createServer();
}
// END OF app.ts
