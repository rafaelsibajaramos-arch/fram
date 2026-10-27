const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { client, owner, services } = require('./multirepo-github.cjs');
const base = path.resolve(__dirname, '../repositorios');
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); }
function scan(cwd) {
  for (const file of git(cwd, 'ls-files', '-z').split('\0').filter(Boolean)) {
    if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.env.example')) throw new Error('Archivo de entorno prohibido: ' + file);
    if (/\.(pem|key|bak)$/.test(file)) throw new Error('Archivo privado/respaldo: ' + file);
    const content = fs.readFileSync(path.join(cwd, file), 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}/.test(content)) throw new Error('Posible secreto en ' + file);
    if (file.endsWith('.env.example')) {
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^(?:JWT_PRIVATE_KEY|SMTP_PASS|RESEND_API_KEY|NEON_API_KEY|RAILWAY_TOKEN)=(.*)$/);
        if (match && !/^(?:""|''|CHANGE_ME|your[-_\w]*|tu[-_\w]*|<[^>]+>)?$/i.test(match[1].trim())) throw new Error('Ejemplo con valor sensible: ' + file);
      }
    }
  }
}
async function main() {
  const targets = process.argv.slice(2);
  const api = client();
  for (const name of targets) {
    if (!['pipelines', ...services].includes(name)) throw new Error('Repositorio fuera del alcance');
    const cwd = path.join(base, name);
    const initialized = fs.existsSync(path.join(cwd, '.git'));
    const hasOrigin = initialized && git(cwd, 'remote').split(/\r?\n/).includes('origin');
    if (hasOrigin && git(cwd, 'remote', 'get-url', 'origin').trim() !== `https://github.com/${owner}/${name}.git`) throw new Error('El repositorio local ya tiene otro origen');
    if (!initialized) git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', owner);
    git(cwd, 'config', 'user.email', `${owner}@users.noreply.github.com`);
    git(cwd, 'config', 'core.autocrlf', 'false');
    git(cwd, 'config', 'credential.username', owner);
    git(cwd, 'add', '--all');
    scan(cwd);
    if (git(cwd, 'diff', '--cached', '--name-only').trim()) {
      git(cwd, 'commit', '-m', 'Initialize standalone FarmToTable repository and shared CI/CD integration');
    }
    if (!hasOrigin) {
      git(cwd, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`);
    }
    git(cwd, 'push', '-u', 'origin', 'main');
    await api(`/repos/${owner}/${name}`, 'PATCH', { default_branch: 'main' });
    console.log(JSON.stringify({ published: name, commit: git(cwd, 'rev-parse', 'HEAD').trim() }));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { scan };
