// Test server: serves the demo SPA (with a failing API), a page with a strict
// CSP and a page full of fake secrets (/secrets/, for the redaction tests).
// With the cookie demo=v2 it plays a newer version: checkout works, the hint
// text has enough contrast, everything else is unchanged (for re-tests).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./demo-app/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export function startServer(port = 4173) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const v2 = /(?:^|;\s*)demo=v2(?:;|$)/.test(req.headers.cookie || '');
    if (url.pathname === '/api/checkout') {
      await new Promise((r) => setTimeout(r, 200));
      if (v2) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': 'req-7f3a9c' });
      return res.end('{"error":"payment-service unavailable","code":"PAY_503"}');
    }
    if (url.pathname === '/api/secret-fail') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"invalid credentials","access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl","email":"max.mustermann@firma.de"}');
    }
    const hostile = url.pathname.startsWith('/hostile');
    const secrets = url.pathname.startsWith('/secrets');
    const file = extname(url.pathname) ? url.pathname.slice(1) : hostile ? 'hostile/index.html' : secrets ? 'secrets/index.html' : 'index.html';
    try {
      let data = await readFile(join(ROOT, file));
      if (v2 && file === 'index.html') {
        data = String(data)
          .replace('<meta name="version" content="2.3.1-demo">', '<meta name="version" content="2.4.0-demo">')
          .replace('</head>', '<style>.hint-text { color: #595959; font-size: 14px; }</style></head>');
      }
      const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream' };
      if (hostile) {
        headers['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
      }
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 4173);
  await startServer(port);
  console.log(`Demo app on http://localhost:${port}`);
}
