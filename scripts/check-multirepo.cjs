const { client, services, owner } = require('./multirepo-github.cjs');
async function main() {
  const api = client();
  for (const service of services) {
    const run = (await api(`/repos/${owner}/${service}/actions/runs?event=workflow_dispatch&per_page=1`)).workflow_runs[0];
    const jobs = (await api(`/repos/${owner}/${service}/actions/runs/${run.id}/jobs`)).jobs;
    console.log(JSON.stringify({ service, url: run.html_url, status: run.status, result: run.conclusion, jobs: jobs.map(j => ({ name: j.name, result: j.conclusion, status: j.status, failed_steps: j.steps?.filter(s => s.conclusion === 'failure').map(s => s.name) })) }));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
