const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { client, owner, services } = require('./multirepo-github.cjs');
async function main() {
  const api = client();
  const evidence = [];
  for (const service of services) {
    const runs = await api(`/repos/${owner}/${service}/actions/runs?event=push&per_page=1`);
    const run = runs.workflow_runs[0];
    assert.equal(run.conclusion, 'success', service);
    const jobs = await api(`/repos/${owner}/${service}/actions/runs/${run.id}/jobs`);
    evidence.push({ service, run_id: run.id, url: run.html_url, commit: run.head_sha, jobs: jobs.jobs.map(j => ({ name: j.name, conclusion: j.conclusion })) });
  }
  const negative = (await api(`/repos/${owner}/producer-service/actions/runs?event=workflow_dispatch&per_page=1`)).workflow_runs[0];
  assert.equal(negative?.conclusion, 'failure', 'Esperar la ejecución fallida');
  const negativeJobs = (await api(`/repos/${owner}/producer-service/actions/runs/${negative.id}/jobs`)).jobs;
  assert.equal(negativeJobs.find(j => j.name.endsWith('Docker image'))?.conclusion, 'skipped');
  assert.equal(negativeJobs.find(j => j.name.endsWith('Deploy Railway production'))?.conclusion, 'skipped');
  const dest = path.resolve(__dirname, '../repositorios/pipelines/evidencias');
  fs.mkdirSync(dest, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    for (const [name, url] of [['01-ejecucion-exitosa-ci-docker', evidence[0].url], ['02-falla-controlada-bloqueo', negative.html_url]]) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('main').waitFor();
      await page.waitForTimeout(2500);
      console.log(JSON.stringify({ screenshot: name, title: await page.title(), visible: (await page.locator('main').innerText()).slice(0, 900) }));
      await page.screenshot({ path: path.join(dest, name + '.png'), fullPage: true });
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ services: evidence, failure: { id: negative.id, url: negative.html_url, jobs: negativeJobs.map(j => ({ name: j.name, conclusion: j.conclusion })) } }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
