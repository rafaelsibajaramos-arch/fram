// GitHub credential stays in process memory; never log or persist it.
const { execFileSync } = require('node:child_process');
const owner = 'rafaelsibajaramos-arch';
const services = ['producer-service', 'catalog-service', 'identity-service', 'inventory-service', 'order-service', 'payment-service', 'logistics-service', 'notification-service', 'analytics-service'];
function credential() {
  const raw = execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=github.com\nusername=${owner}\n\n`, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  const entry = raw.split(/\r?\n/).find(line => line.startsWith('password='));
  if (!entry) throw new Error('GitHub requiere autenticar la cuenta autorizada');
  return entry.slice(9);
}
function client() {
  const token = credential();
  return async (route, method = 'GET', body, allow404 = false) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    const value = response.status === 204 ? null : response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${value?.message ?? ''}`);
    return value;
  };
}
async function inspect() {
  const api = client();
  const user = await api('/user');
  if (user.login.toLowerCase() !== owner.toLowerCase()) throw new Error('La credencial corresponde a otra cuenta');
  console.log(JSON.stringify({ authenticated: user.login }));
  for (const name of ['pipelines', ...services]) {
    const repo = await api(`/repos/${owner}/${name}`, 'GET', undefined, true);
    console.log(JSON.stringify({ name, exists: Boolean(repo), visibility: repo?.visibility, empty: repo?.size === 0 }));
  }
}
module.exports = { client, owner, services };
if (require.main === module) inspect().catch(error => { console.error(error.message); process.exitCode = 1; });
