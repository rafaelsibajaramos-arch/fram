const fs = require('node:fs');
const path = require('node:path');
async function railway(query, variables = {}) {
  const user = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.railway/config.json'), 'utf8')).user;
  const token = user.accessToken || user.token;
  if (!token) throw new Error('Railway requiere autenticación');
  const response = await fetch('https://backboard.railway.com/graphql/v2', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Railway API: ${response.status} ${body.errors?.map(e => e.message).join('; ') ?? ''}`);
  return body.data;
}
module.exports = { railway };
if (require.main === module) railway(`query { mutation: __type(name:"Mutation") { fields { name args { name type { kind name ofType { kind name } } } type { kind name ofType { name } } } } instance: __type(name:"ServiceInstanceUpdateInput") { inputFields { name type { kind name ofType { name } } } } token: __type(name:"ProjectTokenCreateInput") { inputFields { name type { kind name ofType { name } } } } }`).then(data => console.log(JSON.stringify({ mutation: data.mutation.fields.filter(f => /projectTokenCreate|serviceInstanceUpdate|serviceUpdate/.test(f.name)), instance: data.instance, token: data.token }))).catch(error => { console.error(error.message); process.exitCode = 1; });
