$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$environmentNames = @(
  'JWT_SECRET', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY',
  'ANALYTICS_DATABASE_URL', 'ANALYTICS_DIRECT_URL',
  'LOGISTICS_DATABASE_URL', 'LOGISTICS_DIRECT_URL',
  'NOTIFICATION_DATABASE_URL', 'NOTIFICATION_DIRECT_URL'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
  # All credentials here are ephemeral development-only values. The three
  # placeholder URLs satisfy base Compose interpolation; the local overlay
  # replaces them with the isolated PostgreSQL containers before startup.
  $generatedKeys = & node -e "const c=require('node:crypto'); const pair=c.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}); process.stdout.write(JSON.stringify({secret:c.randomBytes(32).toString('base64'),privateKey:pair.privateKey,publicKey:pair.publicKey}));"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudieron generar las claves JWT locales' }
  $keyMaterial = ($generatedKeys -join '') | ConvertFrom-Json
  $env:JWT_SECRET = $keyMaterial.secret
  $env:JWT_PRIVATE_KEY = $keyMaterial.privateKey.Replace("`r`n", '\n').Replace("`n", '\n')
  $env:JWT_PUBLIC_KEY = $keyMaterial.publicKey.Replace("`r`n", '\n').Replace("`n", '\n')
  $placeholderUrl = 'postgresql://local:local@127.0.0.1:1/local?schema=public'
  foreach ($name in @(
    'ANALYTICS_DATABASE_URL', 'ANALYTICS_DIRECT_URL',
    'LOGISTICS_DATABASE_URL', 'LOGISTICS_DIRECT_URL',
    'NOTIFICATION_DATABASE_URL', 'NOTIFICATION_DIRECT_URL'
  )) {
    [Environment]::SetEnvironmentVariable($name, $placeholderUrl, 'Process')
  }

  $composeArgs = @(
    '--parallel', '2',
    '--env-file', '.env.example',
    '-p', 'farmtotable-local',
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.local.yml',
    'up', '-d', '--build', '--wait', '--wait-timeout', '300'
  )
  & docker compose @composeArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose terminó con código $LASTEXITCODE" }
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
  Pop-Location
}
