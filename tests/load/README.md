# Prueba de capacidad en staging

`marketplace.js` implementa el perfil inicial descrito en Momento 1: durante 12 minutos escala de 0 a 20 VU, mantiene 20, sube a 100, sostiene el pico y desciende; el reparto en pico es 70% catálogo, 20% carrito y 10% pedidos. Los umbrales propuestos son error HTTP <1%, p95 catálogo <500 ms, p95 de solicitudes de pedidos <1.500 ms y p95 de confirmación de la saga <5 s.

No es una prueba para producción. Requiere un staging aislado, 200 cuentas buyer verificadas y dedicadas: 100 para pedidos/lecturas de catálogo y 100 separadas para carrito, evitando escrituras concurrentes cruzadas. Cada uno de los 10 VU de pedidos crea hasta diez compras con su cuenta asignada (prepara saldo y stock para diez unidades de compra por cuenta) y luego consulta esos pedidos; el gate exige al menos 100 pedidos confirmados. Cada pedido debe confirmar en 30 segundos; una cancelación o timeout rompe el umbral. El script inicia y revoca sesiones de prueba, pero los pedidos y movimientos de staging deben limpiarse mediante el procedimiento de fixture del ambiente después de guardar la evidencia.

Variables, provistas por un gestor de secretos de staging y nunca impresas:

- `BASE_URL`: URL HTTPS del Gateway de staging.
- `PRODUCTION_BASE_URL`: URL de producción para que el script rechace un destino idéntico.
- `TARGET_ENV=staging` y `ALLOW_STAGING_LOAD_TEST=true`: doble confirmación obligatoria.
- `K6_BUYERS_JSON`: JSON de mínimo 200 objetos con `email`, `password`, `productId`, `quantity` y `deliveryAddress`. No reutilizar usuarios reales. Las primeras 100 cuentas deben financiar diez compras de la cantidad configurada y tener inventario por encima de esa demanda; las otras 100 solo necesitan un producto válido para el ejercicio de carrito.
- `TEST_RUN_ID`: identificador único no secreto de esta ejecución, recomendado para idempotencia y trazabilidad. No reutilices el mismo valor al repetir la prueba con las mismas cuentas.

Ejemplo PowerShell; prepara el JSON fuera de la línea de comandos para no dejar contraseñas en historial:

```powershell
$env:TARGET_ENV = 'staging'
$env:ALLOW_STAGING_LOAD_TEST = 'true'
$env:BASE_URL = 'https://<gateway-staging>'
$env:PRODUCTION_BASE_URL = 'https://<gateway-production>'
$env:K6_BUYERS_JSON = Get-Content -Raw -LiteralPath '.\staging-buyers.json'
$env:TEST_RUN_ID = [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force artifacts | Out-Null
docker run --rm `
  -v "${PWD}/tests/load:/scripts:ro" `
  -v "${PWD}/artifacts:/artifacts" `
  -e BASE_URL -e PRODUCTION_BASE_URL -e TARGET_ENV -e ALLOW_STAGING_LOAD_TEST `
  -e K6_BUYERS_JSON -e TEST_RUN_ID `
  grafana/k6:0.55.0 run --include-system-env-vars --summary-export=/artifacts/k6-summary.json /scripts/marketplace.js
```

Almacena el resumen junto al SHA, versión de k6, fixture y configuración/recurso del ambiente por 30 días. El resumen marca la igualdad entre pedidos creados y confirmados; cada VU falla además si su pedido no confirma antes de 30 s. k6 no mide por sí solo CPU, memoria, conexiones ni profundidad de RabbitMQ: adjunta esos paneles de staging al informe antes de usarlo como gate de promoción. Los umbrales son metas iniciales, no resultados ni capacidad ya demostrada.
