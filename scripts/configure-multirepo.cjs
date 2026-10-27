const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { client, owner, services } = require('./multirepo-github.cjs');
const { railway } = require('./multirepo-railway.cjs');
const projectId = '9ed42143-f510-4174-ac9c-9a8cd48ec228';
const environmentId = 'd7ea24be-db50-41a1-8f3c-c11e627eb6f6';
const ids = {
  'producer-service': '6ecfa39a-1951-4fca-ac29-ce59a6d2adca', 'catalog-service': 'bc425525-92e3-4682-8254-c6b2d37141ef',
  'identity-service': 'ea5af6c6-1107-4c6a-9451-96b83cf2ea19', 'inventory-service': 'bc73d289-9532-470b-b426-77f3f0374dc7',
  'order-service': 'a908fbd9-998d-459b-91a3-0e2d69e81a62', 'payment-service': 'f246e83d-5815-47c4-9644-57e4df33e8f3',
  'logistics-service': 'afeab592-535c-45a8-b663-1762f09a796e', 'notification-service': '70fd3f3d-4b50-4bbb-b80b-f23fb65a002e',
  'analytics-service': '1b821399-5ba3-4c66-946c-3f8340e36dee',
};
async function variable(api, repo, name, value) {
  const route = `/repos/${owner}/${repo}/actions/variables`;
  const old = await api(`${route}/${name}`, 'GET', undefined, true);
  await api(old ? `${route}/${name}` : route, old ? 'PATCH' : 'POST', { name, value });
}
async function main() {
  const mode = process.argv[2] ?? 'inspect';
  if (mode === 'inspect') {
    console.log(JSON.stringify(await railway(`query { __type(name:"ServiceSourceInput") { inputFields { name type { name kind } } } }`)));
    return;
  }
  const api = client();
  if (mode === 'vars') {
    for (const service of services) {
      await api(`/repos/${owner}/${service}/environments/production`, 'PUT', {});
      for (const [name, value] of Object.entries({ RAILWAY_PROJECT_ID: projectId, RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_SERVICE_ID: ids[service], DEPLOY_ENABLED: 'false' })) await variable(api, service, name, value);
      console.log(JSON.stringify({ destination_configured: service, deployment_enabled: false }));
    }
    return;
  }
  if (mode === 'secrets') {
    const sodium = require(path.resolve(__dirname, '../repositorios/.tools/node_modules/libsodium-wrappers'));
    await sodium.ready;
    const dotenv = require('../frontend/node_modules/dotenv');
    const localEnv = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
    const projectToken = process.env.RAILWAY_TOKEN || localEnv.RAILWAY_TOKEN;
    if (!projectToken || projectToken === 'pega_aqui_el_token') throw new Error('Falta guardar RAILWAY_TOKEN en .env; no se modifica producción');
    const check = await fetch('https://backboard.railway.com/graphql/v2', { method: 'POST', headers: { 'Project-Access-Token': projectToken, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ projectToken { projectId environmentId } }' }), signal: AbortSignal.timeout(15000) }).then(r => r.json());
    if (check.data?.projectToken?.projectId !== projectId || check.data?.projectToken?.environmentId !== environmentId) throw new Error('El token no está acotado al proyecto/entorno autorizado');
    for (const service of services) {
      const route = `/repos/${owner}/${service}`;
      const key = await api(`${route}/actions/secrets/public-key`);
      const encrypted = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(projectToken), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL);
      await api(`${route}/actions/secrets/RAILWAY_TOKEN`, 'PUT', { encrypted_value: encrypted, key_id: key.key_id });
      await api(`${route}/environments/production`, 'PUT', {});
      console.log(JSON.stringify({ configured: service, encrypted_secret: true, deployment_enabled: false }));
    }
    return;
  }
  if (mode === 'cutover') {
    // Validate every repository before changing any Railway build source.
    for (const service of services) {
      if (!await api(`/repos/${owner}/${service}/actions/secrets/RAILWAY_TOKEN`, 'GET', undefined, true)) throw new Error('Falta el secret de ' + service);
      const runs = await api(`/repos/${owner}/${service}/actions/runs?event=push&per_page=1`);
      if (runs.workflow_runs[0]?.conclusion !== 'success') throw new Error('Todavía no aprobó el CI inicial de ' + service);
    }
    const status = JSON.parse(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes @railway/cli status --json'], { encoding: 'utf8', timeout: 60000 }));
    const instances = status.environments.edges.find(e => e.node.id === environmentId).node.serviceInstances.edges.map(e => e.node);
    for (const service of services) {
      // This removes the old GitHub trigger, not the running service/data.
      if (instances.find(s => s.serviceId === ids[service])?.source?.repo) execFileSync('cmd.exe', ['/d', '/s', '/c', `npx --yes @railway/cli service source disconnect --project ${projectId} --environment ${environmentId} --service ${ids[service]} --json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      const toml = fs.readFileSync(path.resolve(__dirname, '../repositorios', service, 'railway.toml'), 'utf8');
      const healthcheckPath = toml.match(/healthcheckPath\s*=\s*"([^"]+)"/)?.[1];
      if (!healthcheckPath) throw new Error('Falta healthcheck de ' + service);
      await railway(`mutation($serviceId:String!,$environmentId:String,$input:ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input) }`, { serviceId: ids[service], environmentId, input: { rootDirectory: '/', railwayConfigFile: null, dockerfilePath: 'Dockerfile', healthcheckPath, preDeployCommand: ['npm run prisma:deploy'] } });
      await variable(api, service, 'DEPLOY_ENABLED', 'true');
      console.log(JSON.stringify({ workflow_owns_deployment: service, runtime_variables_unchanged: true }));
    }
    return;
  }
  if (mode === 'deploy' || mode === 'failure') {
    const targets = mode === 'failure' ? ['producer-service'] : services;
    for (const service of targets) {
      await api(`/repos/${owner}/${service}/actions/workflows/deploy.yml/dispatches`, 'POST', { ref: 'main', inputs: { 'failure-demo': mode === 'failure' ? 'true' : 'false' } });
      console.log(JSON.stringify({ dispatched: service, failure_demo: mode === 'failure' }));
    }
    return;
  }
  throw new Error('Modo desconocido');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { variable, ids, projectId, environmentId };
