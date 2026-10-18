# Analytics Service

Proyección analítica independiente de las bases transaccionales. Consume eventos de negocio versionados desde RabbitMQ, los guarda de forma idempotente junto con hechos tipados y sirve informes administrativos. No consulta por REST las bases de otros servicios.

## Ejecutar localmente

1. Copiar `.env.example` a `.env` dentro de este servicio y completar una base PostgreSQL exclusiva de desarrollo y RabbitMQ. No reutilizar cadenas de producción.
2. Instalar dependencias y generar/aplicar el esquema:

   ```sh
   npm ci
   npx prisma generate
   npx prisma migrate deploy
   npm run start:dev
   ```

3. El servicio escucha en `PORT` (3009 por defecto), usa `/api/v1` como prefijo, y ofrece `/api/v1/health` y `/api/v1/health/ready`.

## Informes

Todos los informes requieren rol administrativo y aceptan `start`, `end` (`YYYY-MM-DD`, inclusivo para `start` y exclusivo para `end`) y `timezone` IANA. Las fechas representan medianoches de la zona indicada y se convierten a UTC respetando sus cambios de horario. El periodo máximo es 366 días.

| GET | Fuente y fórmula resumida |
|---|---|
| `/api/v1/analytics/sales` | Capturas de pago; ingreso por producto prorrateado dentro del pedido contra líneas efectivamente aceptadas. Reembolsos y capturas sin atribución se informan aparte. |
| `/api/v1/analytics/waste` | Kg de merma registrados; cohorte por lote contra kg inicialmente cosechados. Mermas sin lote disminuyen la cobertura de cohorte. |
| `/api/v1/analytics/inventory-rotation` | Kg despachados / inventario físico medio ponderado por tiempo. Solo puede estimarse para lotes con snapshot previo al periodo. |
| `/api/v1/analytics/deliveries` | Entregas vencidas en el periodo; excluye cancelación anterior a inicio de ventana. Incluye duración despachada-entregada, p95 e incidentes de cadena de frío. |
| `/api/v1/analytics/satisfaction` | Promedio, cantidad y distribución de ratings recibidos. Ausencia de opiniones no se interpreta como cero. |

`POST /api/v1/analytics/reports/:type` persiste una instantánea y genera `report.generated` mediante outbox; `GET /api/v1/analytics/reports` lista metadatos. Todas las respuestas indican periodo, zona horaria, fórmula, fecha de generación y cobertura cuando corresponde.

`POST /api/v1/analytics/rebuild` reconstruye las tablas de hechos desde `processed_events`. Solo lo puede ejecutar un administrador y requiere `{"confirmation":"REBUILD_ANALYTICS_PROJECTIONS"}`. La operación conserva el archivo de eventos, periodos, informes y outbox; reemplaza las proyecciones dentro de una transacción y toma un bloqueo para que los consumidores esperen hasta el commit. Si un evento archivado no se puede proyectar, la transacción revierte y conserva el estado anterior. Ejecutar como mantenimiento: puede tardar según el tamaño del archivo y bloquear temporalmente nuevos eventos.

## Contrato de eventos

El consumidor valida el envelope compartido (`event_id`, `event_type`, `source_service`, `entity_id`, `entity_version`, `schema_version`, `occurred_at`, `correlation_id`, `payload`). La deduplicación se hace por `event_id` y por versión de entidad/origen/tipo. Los eventos admitidos están enumerados en `src/analytics.service.ts` y los validadores de payload allí definidos; publicar un evento desconocido o inválido no crea un hecho.

Fuentes previstas: pedidos confirmados y cierre de fulfillment, capturas/reembolsos, lotes de cosecha, movimientos/snapshots/mermas de inventario, estados de entrega, alertas de frío, altas/cambios de productos y productores y `rating.created`. La cobertura real depende de que cada productor publique el contrato con la misma semántica. El servicio no inventa snapshots iniciales ni ratings faltantes.

## Comprobaciones

```sh
npm run build
npm test -- --runInBand
npx prisma validate
npx prisma migrate deploy
```

La reconstrucción cuenta con integración E2E contra PostgreSQL 16 temporal: comprueba replay, idempotencia, conservación de informes/outbox y rollback ante un evento histórico inválido. `npm run test:e2e:analytics-rebuild` desde la raíz ejecuta esa prueba sin leer credenciales locales. Siguen pendientes E2E de todos los productores de eventos (incluido `rating.created`) y snapshots operativos iniciales de Inventario para medir rotación histórica completa.
