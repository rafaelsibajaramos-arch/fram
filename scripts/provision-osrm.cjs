const { execFileSync } = require('node:child_process');
const { railway } = require('./multirepo-railway.cjs');
const { projectId, environmentId } = require('./configure-multirepo.cjs');
async function main() {
  const status = JSON.parse(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes @railway/cli status --json'], { encoding: 'utf8', timeout: 60000 }));
  if (status.id !== projectId) throw new Error('Proyecto distinto al autorizado');
  const environment = status.environments.edges.find(e => e.node.id === environmentId)?.node;
  if (!environment || environment.name !== 'production') throw new Error('No es producción');
  let serviceId = status.services.edges.find(e => e.node.name === 'routing-osrm')?.node.id;
  if (!serviceId) {
    const response = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes @railway/cli add --service routing-osrm --variables PORT=5000 --json'], { encoding: 'utf8', timeout: 60000 });
    console.log(response.trim());
    const updated = JSON.parse(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes @railway/cli status --json'], { encoding: 'utf8', timeout: 60000 }));
    serviceId = updated.services.edges.find(e => e.node.name === 'routing-osrm')?.node.id;
  }
  if (!serviceId) throw new Error('No se pudo identificar routing-osrm');
  await railway(`mutation($serviceId:String!,$environmentId:String,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}`, { serviceId, environmentId, input: { rootDirectory: '/', dockerfilePath: 'Dockerfile', healthcheckPath: '/health', healthcheckTimeout: 240, numReplicas: 1 } });
  console.log(JSON.stringify({ serviceId, environmentId, privateOnly: true, healthcheckConfigured: true }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
