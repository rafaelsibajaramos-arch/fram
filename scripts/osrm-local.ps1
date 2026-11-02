$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectDirectory '.local-logistics\osrm'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$dataDirectory = (Resolve-Path -LiteralPath $dataDirectory).Path
$imageName = 'ghcr.io/project-osrm/osrm-backend:v6.0.0'
& docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Inicia Docker Desktop antes de preparar OSRM.' }
$pbfFile = Join-Path $dataDirectory 'colombia.osm.pbf'
if (-not (Test-Path -LiteralPath $pbfFile)) {
  $downloadFile = Join-Path $dataDirectory 'colombia.osm.pbf.download'
  & curl.exe --fail --location --retry 3 'https://download.geofabrik.de/south-america/colombia-latest.osm.pbf' --output $downloadFile
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo descargar la cartografía de Colombia.' }
  Move-Item -LiteralPath $downloadFile -Destination $pbfFile
}
$readyFile = Join-Path $dataDirectory 'prepared-v6.txt'
if (-not (Test-Path -LiteralPath $readyFile)) {
  foreach ($arguments in @(
    ,@('osrm-extract', '--threads', '2', '-p', '/opt/car.lua', '/data/colombia.osm.pbf'),
    ,@('osrm-partition', '--threads', '2', '/data/colombia.osrm'),
    ,@('osrm-customize', '--threads', '2', '/data/colombia.osrm')
  )) {
    & docker run --rm --memory 5g -v "${dataDirectory}:/data" $imageName @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Falló la preparación de la cartografía; no se iniciará un motor incompleto.' }
  }
  Set-Content -LiteralPath $readyFile -Value 'OSRM v6; Colombia; car.lua; MLD. Sin tráfico en vivo ni garantía de restricciones para camiones.'
}
& docker compose -p farmtotable-routing -f (Join-Path $projectDirectory 'infrastructure\osrm\compose.yml') up -d
if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar OSRM.' }
Write-Output 'OSRM local: http://127.0.0.1:5500. Configura OSRM_URL en el proceso local de logistics-service.'
