const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const root = path.resolve(__dirname, '../repositorios/pipelines');
  const text = fs.readFileSync(path.join(root, 'INFORME_REFLEXION.md'), 'utf8');
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const paragraphs = text.split(/\r?\n\r?\n/).map((s, i) => i === 0 ? `<h1>${escape(s.replace(/^# /, ''))}</h1>` : `<p>${escape(s).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`).join('');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<html lang="es"><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:11pt/1.35 Arial;color:#172b25}h1{font-size:17pt}p{text-align:justify;margin:10px 0}code{font-size:10pt}</style>${paragraphs}</html>`);
    await page.pdf({ path: path.join(root, 'INFORME_REFLEXION.pdf'), format: 'A4', preferCSSPageSize: true });
    console.log('PDF de reflexión exportado; completar integrantes reales antes de entregar.');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
