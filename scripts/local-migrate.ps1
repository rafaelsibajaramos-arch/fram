$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$services = @(
  @{ Name = 'producer-service'; Db = 'producer_db'; Port = 15431 },
  @{ Name = 'catalog-service'; Db = 'catalog_db'; Port = 15432 },
  @{ Name = 'identity-service'; Db = 'identity_db'; Port = 15433 },
  @{ Name = 'inventory-service'; Db = 'inventory_db'; Port = 15434 },
  @{ Name = 'order-service'; Db = 'order_db'; Port = 15435 },
  @{ Name = 'payment-service'; Db = 'payment_db'; Port = 15436 },
  @{ Name = 'logistics-service'; Db = 'logistics_db'; Port = 15437 },
  @{ Name = 'notification-service'; Db = 'notification_db'; Port = 15438 },
  @{ Name = 'analytics-service'; Db = 'analytics_db'; Port = 15439 }
)

$previousDatabaseUrl = $env:DATABASE_URL
$previousDirectUrl = $env:DIRECT_URL

try {
  foreach ($service in $services) {
    $url = "postgresql://farmtotable:farmtotable_local_only@127.0.0.1:$($service.Port)/$($service.Db)?schema=public"
    $env:DATABASE_URL = $url
    $env:DIRECT_URL = $url
    $servicePath = Join-Path $repoRoot $service.Name
    $prismaExecutable = Join-Path $servicePath 'node_modules/.bin/prisma'
    if ($IsWindows) { $prismaExecutable += '.cmd' }
    if (-not (Test-Path $prismaExecutable)) {
      Write-Host "Instalando dependencias: $($service.Name)"
      npm --prefix $servicePath ci
      if ($LASTEXITCODE -ne 0) { throw "Falló npm ci para $($service.Name)" }
    }
    npm --prefix $servicePath run prisma:generate
    if ($LASTEXITCODE -ne 0) { throw "Falló prisma:generate para $($service.Name)" }
    Write-Host "Aplicando migraciones locales: $($service.Name)"
    npm --prefix $servicePath run prisma:deploy
    if ($LASTEXITCODE -ne 0) { throw "Falló prisma:deploy para $($service.Name)" }
  }
} finally {
  if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
  else { $env:DATABASE_URL = $previousDatabaseUrl }
  if ($null -eq $previousDirectUrl) { Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue }
  else { $env:DIRECT_URL = $previousDirectUrl }
}
