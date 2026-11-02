const http = require('node:http');
const { spawn } = require('node:child_process');
const backend = process.env.OSRM_BACKEND_URL || 'http://127.0.0.1:5001';
const child = process.env.OSRM_SKIP_SPAWN === 'true' ? null : spawn('osrm-routed', ['--algorithm', 'mld', '--mmap', '--ip', '127.0.0.1', '--port', '5001', '--threads', '2', '--max-table-size', '64', '--max-viaroute-size', '64', '/data/colombia.osrm'], { stdio: 'inherit' });
const server = http.createServer(async (req, res) => {
  const health = req.url === '/health';
  if (req.method !== 'GET' || (!health && (!/^\/(route|table|nearest)\/v1\/driving\//.test(req.url) || req.url.length > 8192))) { res.writeHead(404).end(); return; }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), health ? 3000 : 15000);
  res.on('close', () => abort.abort());
  try {
    const response = await fetch(backend + (health ? '/nearest/v1/driving/-75.88,8.75' : req.url), { signal: abort.signal });
    const body = await response.text();
    if (health) {
      const ready = response.ok && JSON.parse(body).code === 'Ok';
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ready ? 'ready' : 'unavailable', dataset: 'Colombia', engine: 'OSRM' }));
    } else res.writeHead(response.status, { 'content-type': 'application/json' }).end(body);
  } catch { if (!res.writableEnded) res.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"Motor vial no disponible"}'); }
  finally { clearTimeout(timeout); }
});
const stop = () => { server.close(); child?.kill('SIGTERM'); setTimeout(() => process.exit(0), 4000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child?.on('error', () => process.exit(1)); child?.on('exit', code => { server.close(); process.exit(code || 1); });
server.listen(Number(process.env.PORT || 5000), '::');
