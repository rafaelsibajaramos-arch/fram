// Mechanical source export only. Configuration changes are applied separately.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { services } = require('./multirepo-github.cjs');
const source = path.resolve(__dirname, '..');
const destination = path.resolve(source, 'repositorios');
if (fs.existsSync(destination)) throw new Error('El destino ya existe: no se sobrescribirá');
fs.mkdirSync(destination);
for (const service of services) {
  const target = path.join(destination, service);
  fs.mkdirSync(target);
  const tracked = execFileSync('git', ['ls-files', '-z', '--', service], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  let count = 0;
  for (const file of tracked) {
    const relative = path.relative(path.join(source, service), path.join(source, file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Ruta fuera del microservicio');
    if (/\.bak$|(^|[\\/])auth-check\.cjs$/.test(relative)) continue;
    if (/(^|[\\/])\.env($|\.)/.test(relative) && path.basename(relative) !== '.env.example') throw new Error('Se detectó un archivo de entorno rastreado');
    const output = path.join(target, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(source, file), output);
    count++;
  }
  fs.copyFileSync(path.join(source, 'scripts/eslint.config.mjs'), path.join(target, 'eslint.config.mjs'));
  console.log(JSON.stringify({ service, exported_files: count }));
}
fs.mkdirSync(path.join(destination, 'pipelines'));
console.log(JSON.stringify({ destination }));
