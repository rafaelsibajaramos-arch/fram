const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { client, owner, services } = require('./multirepo-github.cjs');
async function main() {
  const mode = process.argv[2];
  assert.ok(['failure', 'success'].includes(mode));
  const api = client();
  const records = await Promise.all(services.map(async service => {
    const run = (await api(`/repos/${owner}/${service}/actions/runs?event=workflow_dispatch&per_page=1`)).workflow_runs[0];
    assert.equal(run.status, 'completed', service + ': todavía en ejecución');
    assert.equal(run.conclusion, mode, service);
    const jobs = (await api(`/repos/${owner}/${service}/actions/runs/${run.id}/jobs`)).jobs;
    for (const [name, expected] of [['Test and quality gate', mode], ['Docker image', mode === 'failure' ? 'skipped' : 'success'], ['Deploy Railway production', mode === 'failure' ? 'skipped' : 'success']]) {
      assert.equal(jobs.find(j => j.name.endsWith(name))?.conclusion, expected, service + ': ' + name);
    }
    if (mode === 'failure') assert.ok(jobs.some(j => j.steps?.some(s => s.name === 'Controlled failing test for classroom evidence' && s.conclusion === 'failure')), service);
    return { service, id: run.id, url: run.html_url, conclusion: run.conclusion, created_at: run.created_at };
  }));
  const root = path.resolve(__dirname, '../repositorios/pipelines');
  const dest = path.join(root, 'evidencias');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, `ronda-${mode}.json`), JSON.stringify(records, null, 2) + '\n');
  for (const r of records) console.log(JSON.stringify(r));
  if (process.env.PLAYWRIGHT_MODULE_PATH) {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
      for (const r of records) {
        await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('main').waitFor();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(dest, `${r.service}-${mode}.png`), fullPage: true });
        console.log('Captura: ' + r.service + ' ' + mode);
      }
    } finally { await browser.close(); }
  }
  const failed = path.join(dest, 'ronda-failure.json');
  const passed = path.join(dest, 'ronda-success.json');
  if (fs.existsSync(failed) && fs.existsSync(passed)) {
    const failures = JSON.parse(fs.readFileSync(failed));
    const successes = JSON.parse(fs.readFileSync(passed));
    const rows = services.map(s => {
      const f = failures.find(r => r.service === s), p = successes.find(r => r.service === s);
      assert.ok(Date.parse(p.created_at) > Date.parse(f.created_at), s + ': el despliegue debe ser posterior al fallo');
      return `| ${s} | [Fallo controlado](${f.url}) | [Deploy correcto](${p.url}) |`;
    });
    fs.writeFileSync(path.join(root, 'FALLO_Y_DEPLOY_POR_MICROSERVICIO.md'), '# Fallo controlado y despliegue posterior\n\nEn los nueve servicios: la aserción de demostración falló y bloqueó Docker y deploy. Después se ejecutaron pruebas, Docker y despliegue a producción correctamente.\n\n| Microservicio | Intento fallido | Ejecución posterior exitosa |\n| --- | --- | --- |\n' + rows.join('\n') + '\n\nLas capturas están en `evidencias/<microservicio>-failure.png` y `evidencias/<microservicio>-success.png`. Los intentos fallidos no desplegaron cambios.\n');
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
