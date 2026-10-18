# FarmToTable

Plataforma de mercado agrícola con nueve microservicios backend, una interfaz web/API Gateway, PostgreSQL por servicio, RabbitMQ y Redis opcional para caché del catálogo. El código está organizado actualmente como **monorepo**.

> Estado de la documentación: describe el código presente en el repositorio. No implica que cada servicio desplegado, integración externa o flujo de producción haya sido validado recientemente. En la verificación local del 17-10-2026 compilaron los siete microservicios; pasaron 39 pruebas de Productores, 79 de Catálogo, 3 de Identidad, 9 de Inventario, 10 de Pedidos, 15 unitarias más 2 de integración local de Pagos y 9 de Logística (164 unitarias en total). Las pruebas E2E entre servicios y los endpoints remotos no se comprobaron.

La verificación transversal local más reciente (18-10-2026) confirmó builds de los nueve servicios y 187 pruebas unitarias backend aprobadas. Pedidos incluye recuperación de autorización tras perderse la respuesta del POST de Pagos; la consulta está limitada a comprador/admin. El Gateway pasó 2 pruebas y chequeos de sintaxis; la app del conductor pasó typecheck, 6 pruebas y exportación Android. Los límites de validación remota/E2E siguen aplicando.

## Componentes

| Componente | Responsabilidad | Puerto local | Base propia |
|---|---|---:|---|
| `identity-service` | Registro, login, JWT RS256, sesiones, verificación de correo, restablecimiento de contraseña, invitaciones, roles y usuarios. | 3003 | `identity_db` |
| `producer-service` | Perfiles de productores, fincas, certificaciones y validaciones internas. | 3001 | `producer_db` |
| `catalog-service` | Categorías, productos, lotes de cosecha, disponibilidad e historial/precio dinámico. | 3002 | `catalog_db` |
| `inventory-service` | Recepción de cosechas, inventario FEFO, reservas, movimientos, mermas y eventos de stock. | 3004 | `inventory_db` |
| `order-service` | Carrito, checkout, registro de pedidos y consulta por comprador, productor o administrador. Orquesta validación de catálogo, reserva, pago y consumo de inventario. | 3005 | `order_db` |
| `payment-service` | TerraWallet, recargas administrativas, autorización, captura, liberación y reembolsos. | 3006 | `payment_db` |
| `logistics-service` | Zonas, transportistas, vehículos, planes, rutas, paradas, entregas parciales, temperatura y eventos de cierre. | 3007 | `logistics_db` |
| `notification-service` | Bandeja in-app, preferencias, correo/SMS opcionales, historial idempotente y eventos de entrega. | 3008 | `notification_db` |
| `analytics-service` | Proyecciones locales de ventas capturadas, mermas, rotación física, ventanas de entrega y satisfacción. | 3009 | `analytics_db` |
| `frontend` | Aplicación web y API Gateway: sirve la interfaz, enruta peticiones, propaga JWT/correlation ID y conecta los servicios. | 4000 | — |
| `driver-mobile` | Aplicación nativa Expo/React Native para rutas, paradas, entregas y cola de sincronización offline. | — | SQLite local |

Cada microservicio administra su propio esquema y no debe consultar ni modificar directamente la base de otro servicio.

## Arquitectura e integración

- El navegador accede a la aplicación por el Gateway en `http://localhost:4000`.
- El Gateway reenvía las rutas a los servicios configurados mediante `*_SERVICE_URL`.
- Pedidos consulta Catálogo y coordina Inventario y Pagos durante el checkout; también consulta Productores para mostrar los pedidos correspondientes a cada productor.
- Catálogo valida referencias de productores/fincas por REST y consume eventos de Productores e Inventario.
- Identidad publica eventos de dominio por RabbitMQ; Productores consume, entre otros, `identity.user_disabled`.
- Inventario recibe cosechas y publica cambios de stock mediante RabbitMQ. Catálogo recalcula disponibilidad/precios a partir de esos eventos.
- Catálogo usa Redis solo como caché opcional; PostgreSQL es la fuente de verdad.

El exchange por defecto es `farmtotable.events`. Los nueve servicios publican o consumen eventos versionados; Notificaciones y Analítica usan colas durables e inbox/outbox idempotentes. Notificaciones crea bandeja in-app sin bloquear pedidos. Analítica construye proyecciones tipadas y reporta ventas capturadas, mermas, rotación, cumplimiento de ventanas y satisfacción, sin consultar bases ajenas. La cobertura de notificaciones/analítica sigue parcial: el replay y reconstrucción transaccional de Analítica ya tiene E2E PostgreSQL local; faltan pruebas de todos los flujos de eventos, reconciliar eventos tardíos y verificar snapshots iniciales para la rotación. Pedidos publica `rating.created` al guardar una calificación. Checkout y logística se prueban por HTTP con servicios, PostgreSQL y RabbitMQ efímeros; se cubren compensación, concurrencia, entregas completas/parciales/fallidas, devolución del saldo no aceptado, liquidación con comisión global del 10% congelada por línea (`PLATFORM_COMMISSION_RATE=0.10`), reentrega idempotente, respuesta HTTP perdida con reintento por clave, recuperación de outbox al reiniciar Pedidos, persistencia de mensajes ante reinicio del broker, crash-gap del consumidor de Logística después del commit y antes del ACK, envío a DLQ tras un reintento acotado y redrive idempotente desde DLQ. SMS requiere proveedor y teléfono verificado.

## Requisitos

- Node.js 22 (coincide con los Dockerfiles) y npm.
- Docker Compose para levantar la pila local completa.
- El Compose base usa PostgreSQL externo configurado en `.env` (por ejemplo, Neon). Para desarrollo sin acceso externo existe `docker-compose.local.yml`, con nueve PostgreSQL efímeros/aislados.
- RabbitMQ local (lo levanta Compose). Redis local lo levanta Compose para Catálogo.
- Claves JWT RSA compatibles entre Identidad (privada y pública) y los servicios que verifican tokens (solo pública).
- SMTP configurado en Identidad para enviar verificación y recuperación de contraseña.

## Configuración local recomendada

1. Copiar `.env.example` a `.env` en la raíz.
2. Completar las URL pooled y directas de las nueve bases, las claves RSA, las credenciales de RabbitMQ y, si se probarán correos, SMTP. No incluir secretos en Git ni compartirlos en capturas.
3. Revisar que las variables sean coherentes entre servicios. Identidad firma JWT; los demás verifican issuer, audience y clave pública.
4. Levantar la aplicación:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

5. Abrir `http://localhost:4000`. Consola de RabbitMQ: `http://localhost:15672` (credenciales definidas por `RABBITMQ_USER` y `RABBITMQ_PASS`).

RabbitMQ y Redis conservan/configuran su estado según el Compose; las bases PostgreSQL siguen siendo externas. Para detener la pila sin borrar datos:

```bash
docker compose down
```

### Stack totalmente local (sin conectar a Neon)

Este override tiene un proyecto, contenedores, volúmenes y puertos separados. No recrea ni modifica los contenedores `farmtotable-*` del Compose base. Requiere Docker Compose v2.24+ por el uso de `!override`.

```powershell
./scripts/local-up.ps1
./scripts/local-migrate.ps1
```

`local-up.ps1` usa `.env.example`, genera claves RSA efímeras para desarrollo y no lee ni modifica `.env`; las URL temporales requeridas por la interpolación de Compose son reemplazadas por el override antes de iniciar los servicios. Abre la web en `http://localhost:14000`. Los nueve PostgreSQL usan volúmenes independientes y publican solo en loopback (`15431`–`15439`); RabbitMQ/Redis también usan puertos separados. `local-migrate.ps1` ejecuta `prisma generate` y `prisma migrate deploy` contra esas bases locales, nunca contra las URLs de `.env`/Neon. El password fijo `farmtotable_local_only` es exclusivamente para esta red de desarrollo y no debe reutilizarse fuera de ella.

El override local expone tokens de verificación de correo para pruebas sin SMTP (`AUTH_EXPOSE_ACTION_TOKENS=true`); la opción existe solo en `docker-compose.local.yml` y no se debe activar en producción. Tras levantar el stack, `npm run test:e2e:local-stack` comprueba por HTTP registro de comprador, verificación, login/JWT a través del Gateway y lectura de catálogo, pedidos y billetera. Crea un comprador de prueba persistente en la base local por ejecución.

Para detener el stack preservando sus datos:

```powershell
docker compose -p farmtotable-local -f docker-compose.yml -f docker-compose.local.yml down
```

No añadir `-v` salvo que se quiera borrar deliberadamente todos los volúmenes y datos locales de esta pila.

## Migraciones

Cada servicio tiene su propio `prisma/schema.prisma` y carpeta `prisma/migrations`. Antes de iniciar una instancia nueva, configurar en el entorno de **ese servicio** `DATABASE_URL` (conexión de runtime) y `DIRECT_URL` (conexión directa para migraciones), y ejecutar:

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
```

No aplicar migraciones de prueba contra producción. Las pruebas E2E pueden insertar y borrar registros; ejecutarlas solo con una base de desarrollo respaldada y autorizada.

Las imágenes Docker de los nueve backends incluyen el CLI `prisma` y el directorio `prisma/migrations` en runtime. Cada backend tiene `railway.toml` que selecciona su Dockerfile, ejecuta `npm run prisma:deploy` como pre-deploy y revisa su endpoint readiness real. El Gateway también tiene configuración de Dockerfile y readiness. En Railway, configura el root directory de cada servicio al directorio correspondiente (`/producer-service`, `/catalog-service`, etc.; `/frontend` para el Gateway) y el config file path absoluto correspondiente (p. ej. `/order-service/railway.toml`). Las migraciones usan `DIRECT_URL`/`DATABASE_URL` de la base aislada de ese servicio. No las incluyas en `CMD` ni las ejecutes por réplica. Primero valida una base staging vacía y su historial de migraciones; no apuntes staging a Neon/producción.

La tabla de servicios, checklist de variables y orden de despliegue está en [RAILWAY_STAGING_RUNBOOK.md](RAILWAY_STAGING_RUNBOOK.md). El runbook es preparación; no implica que Railway esté enlazado o desplegado.

Nota: Railway está retirando Config as Code. Los `railway.toml` son una transición para servicios existentes; antes de crear servicios nuevos, revisa la migración oficial a `.railway/railway.ts` desde un proyecto enlazado y valida el plan antes de aplicar cambios.

## Desarrollo y comprobaciones

Ejecutar desde la carpeta del servicio correspondiente:

```bash
npm ci
npm run start:dev
```

Para ejecución directa, copiar el `.env.example` de cada servicio a `.env` dentro de esa carpeta y completar sus valores; el Gateway lee el `.env` de la raíz y también permite sobrescrituras en `frontend/.env`. El Gateway/UI se ejecuta con `cd frontend && npm ci && npm run dev`; por defecto sirve el puerto 4000 y apunta a los puertos locales listados arriba. Para compilar los servicios:

```bash
cd producer-service && npm ci && npm run build
cd ../catalog-service && npm ci && npm run build
cd ../identity-service && npm ci && npm run build
cd ../inventory-service && npm ci && npm run build
cd ../order-service && npm ci && npm run build
cd ../payment-service && npm ci && npm run build
cd ../logistics-service && npm ci && npx prisma generate && npm run build
cd ../notification-service && npm ci && npx prisma generate && npm run build
cd ../analytics-service && npm ci && npx prisma generate && npm run build
```

Para iniciar el cliente nativo del conductor, consulta [driver-mobile/README.md](driver-mobile/README.md); requiere una cuenta con rol `driver` y `EXPO_PUBLIC_API_URL` apuntando al Gateway.

Pruebas automatizadas disponibles hoy:

| Servicio | Unitarias | E2E |
|---|---|---|
| Productores | `npm test -- --runInBand` (39 aprobadas en la verificación indicada arriba) | `npm run test:e2e` |
| Catálogo | `npm test -- --runInBand` (79 aprobadas en la verificación indicada arriba) | `npm run test:e2e` |
| Identidad | `npm test` (6 pruebas de roles/registro, evento de cambio de roles y límite SMTP real en recuperación; verificadas localmente el 18-10-2026). | No configuradas |
| Inventario | `npm test` (9 pruebas de FEFO, idempotencia, transiciones y consumo atómico por lote; verificadas localmente el 18-10-2026). | No configuradas; migraciones probadas en Postgres temporal local |
| Pedidos | `npm test -- --runInBand` (17 pruebas en 5 suites: checkout, outbox, agregación, compensación, cierre de entrega y rating; verificadas localmente el 18-10-2026). | Migración completa validada en PostgreSQL local temporal; E2E HTTP cubre checkout y cierres completo/parcial/fallido |
| Pagos | `npm test` compila y ejecuta 23 pruebas unitarias de outbox, recarga, autorización, captura, anulación, bloqueo de despacho, liquidación, reembolso y recuperación protegida por pedido; verificadas localmente el 18-10-2026. | El E2E de checkout/logística valida autorización, captura, payout al 10%, compensación y reembolso posterior a transferencia con ajuste diferido/idempotente; `npm run test:integration` cubre publicador/worker con infraestructura local. |
| Logística | `npm test` (11 pruebas; incluye autorización vigente y bloqueo de pago antes del despacho). | E2E local crea rutas y cubre entregas completas, parciales y fallidas; falta dispositivo y sincronización offline real. |
| Notificaciones | `npm test` (7 pruebas) y `npm run test:e2e:notifications` desde la raíz usa el consumidor RabbitMQ real y PostgreSQL efímero. | Verifica avisos para comprador/conductor/productor, replay idempotente y outbox; SMTP/SMS requieren credenciales/proveedor externos. |
| Analítica | `npm test` (9 pruebas unitarias de proyección y reconstrucción). `npm run test:e2e:analytics-rebuild` desde la raíz valida replay transaccional, idempotencia, conservación de informes/outbox y rollback contra PostgreSQL efímero. | Migración validada en base temporal; siguen pendientes E2E de todos los productores de eventos y snapshots operativos iniciales de inventario. |
| Calificaciones de pedido | `order-service`: crea un rating por pedido entregado/parcial y pagado, propiedad del comprador, con outbox atómico `rating.created`. | 3 pruebas unitarias del endpoint de dominio; migración aplicada solo a Postgres temporal. |
| Frontend/Gateway | `npm test` (2 pruebas de acceso/renovación de sesión); todos los archivos JavaScript pasan `node --check`. | No configuradas |
| App conductor | `driver-mobile`: `npm run typecheck`, `npm test` (6 pruebas de flujos offline) y exportación Android con Expo. | No sustituye pruebas en dispositivo ni E2E contra servicios desplegados |
| Checkout, logística y autenticación entre servicios | `npm run test:e2e:checkout` desde la raíz (requiere Docker; infraestructura efímera). | Comprueba compra, respuesta HTTP perdida con reintento idempotente, compensación, concurrencia, ruta, entregas completa/parcial/fallida, replay idempotente, DLQ/redrive acotados, crash-gap real del consumidor de Logística, reinicio de Pedidos con outbox pendiente y persistencia de mensajes al reiniciar RabbitMQ. Los servicios verifican JWT RS256 temporal firmado por el E2E; también se rechazan roles/identidad Gateway falsificados y llamadas sin token. No simula el login HTTP de Identity. |

Prueba de integración de Pagos (solo con infraestructura de desarrollo/local; nunca usar URLs de producción): primero aplicar las migraciones con `cd payment-service && npm run prisma:deploy`, después definir `DATABASE_URL` apuntando a esa base y `RABBITMQ_URL` al broker local, y ejecutar `npm run test:integration`. Las pruebas crean y eliminan su propio evento temporal.

Prueba E2E de checkout y entrega (requiere Docker e imágenes `postgres:16-alpine` y `rabbitmq:3.13-management-alpine`; usa cuatro bases temporales y puertos efímeros, no lee credenciales de Railway/Neon): ejecuta `npm run build` y `npx prisma generate` en `inventory-service`, `order-service`, `payment-service` y `logistics-service`; desde la raíz corre `npm run test:e2e:checkout`. Comprueba compra confirmada, débito TerraWallet, stock consumido, autorización ligada a la ruta antes del despacho, rechazo de anulación concurrente, entregas completa/parcial/fallida, replay idempotente de `order.confirmed`, DLQ para un mensaje inválido tras su reintento, redrive idempotente, reintento de checkout con pérdida simulada de respuesta HTTP y recuperación de un `order.created` pendiente tras reiniciar Pedidos con una sola reserva y un solo débito. También mata el proceso de Logística entre commit del inbox y ACK, verifica que RabbitMQ marca el evento como redeliverado y comprueba que la recuperación idempotente no duplica plan/entrega. Reinicia el broker mientras un mensaje persistente espera en la cola durable de Inventario y valida su procesamiento idempotente al reconectar. Valida pedido entregado/parcial/cancelado, captura solo lo aceptado, devolución del saldo restante, void sin payout al productor cuando no se acepta producto y comisión global del 10%; además, prueba saldo insuficiente y concurrencia por la última unidad. El test detiene y elimina solo los contenedores que crea con el prefijo `ftt-checkout-e2e-`.

### Operación segura de mensajes en DLQ

La herramienta `npm run ops:dlq:redrive -- --queue logistics-service.orders.dead --limit 20` inspecciona la cola de forma pasiva por defecto y no cambia mensajes. Para reencolar, primero corrige la causa del fallo y confirma el exchange/cola destino; en PowerShell define ` $env:RABBITMQ_URL = 'amqp://…' ` y ` $env:RABBITMQ_EXCHANGE = 'farmtotable.events' `, y ejecuta explícitamente `npm run ops:dlq:redrive -- --queue logistics-service.orders.dead --limit 20 --apply`. Usa el exchange configurado por los consumidores y la URL del entorno elegido; nunca pegues credenciales en tickets o logs. El límite máximo es 1000 mensajes por ejecución. Mensajes inválidos o sin ruta original se conservan en DLQ. La publicación tiene semántica al menos una vez (una interrupción entre publicar y confirmar puede producir un duplicado), por lo que los consumidores deben mantener idempotencia/inbox. Esta herramienta no debe apuntarse a producción sin revisión operativa y autorización explícita.

Para desplegar el bloqueo de autorización de despacho, `payment-service` debe tener aplicada la migración `20261018030000_payment_fulfillment_lock`; configura en `logistics-service` `PAYMENT_SERVICE_URL` con la URL privada interna del servicio de Pagos (base URL, sin `/api/v1`) e `INTERNAL_API_KEY` con el mismo secreto configurado en Pagos. Esa configuración de Railway no se realizó desde este repositorio.

## Carga en staging

`tests/load/marketplace.js` implementa el perfil de k6 y los umbrales iniciales de Momento 1. CI valida sintaxis/configuración con `k6 inspect`, sin emitir tráfico. La prueba real de 12 minutos no se ha ejecutado: requiere exclusivamente staging aislado, 200 compradores sintéticos, stock y saldo preparados, y confirmación explícita de destino; sigue las instrucciones en [`tests/load/README.md`](tests/load/README.md). No apuntar a producción.

## Observabilidad local

La pila de desarrollo agrega Prometheus, Blackbox Exporter y Grafana mediante `docker-compose.local.yml`; vigila readiness HTTP y latencia del Gateway y los nueve servicios, y carga alertas/dashboard básicos. Inicia con `./scripts/local-up.ps1`; Grafana está en `http://127.0.0.1:13000` y Prometheus en `http://127.0.0.1:19090`. Detalle, contraseña local y límites de alcance en [`observability/README.md`](observability/README.md). Esto no instala observabilidad en Railway/Neon ni ofrece métricas internas/log aggregation; no publiques esos puertos.

Para comprobar disponibilidad: Productores, Catálogo, Identidad e Inventario exponen `GET /health` y `GET /health/ready`; Pedidos, Pagos y Logística aplican el prefijo global `/api/v1`, por lo que exponen `GET /api/v1/health` y `GET /api/v1/health/ready`. Por ejemplo:

```bash
curl http://localhost:3003/health/ready
curl http://localhost:3004/health/ready
curl http://localhost:3005/api/v1/health/ready
curl http://localhost:3006/api/v1/health/ready
curl http://localhost:3007/api/v1/health/ready
curl http://localhost:3008/api/v1/health/ready
curl http://localhost:3009/api/v1/health/ready
curl http://localhost:4000/api/system/health
```

Los health checks de Identidad e Inventario verifican PostgreSQL y RabbitMQ; los otros servicios pueden comprobar dependencias distintas. Una respuesta local saludable no sustituye la evidencia de que un despliegue remoto está operativo.

## Endpoints principales

Los prefijos siguientes son rutas directas de cada servicio; en la aplicación normalmente se accede a través del Gateway.

- **Identidad** (`:3003`): `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/email/verify`, `/auth/password/reset/request`, `/auth/password/reset/confirm`, `/auth/me`, `/auth/sessions`, `/auth/users` (administración).
- **Productores** (`:3001`): `/producers`, `/producers/:id`, `/producers/:producerId/farms`, `/farms/:id`, `/producers/:producerId/certifications`, `/certifications/:id`; validaciones internas bajo `/internal/*`.
- **Catálogo** (`:3002`): `/categories`, `/products`, `/products/available`, `/products/:id/price`, `/products/:id/prices`, `/harvest-batches`, `/harvest-batches/:id/publish`, `/harvest-batches/:id/close`.
- **Inventario** (`:3004`): `/inventory/receive`, `/inventory/products/:productId`, `/inventory/reservations`, `/inventory/reservations/:id/release`, `/inventory/reservations/:id/consume`, `/inventory/waste`.
- **Pedidos** (`:3005`, prefijo `/api/v1`): `/orders`, `/orders/checkout`, `/orders/:id`, `/orders/:id/rating` (GET/POST, comprador propietario), `/orders/:id/status`, `/orders/cart/:buyerId`.
- **Pagos** (`:3006`, prefijo `/api/v1`): `/payments`, `/payments/:id`, `/payments/wallet/:buyerId`, `/payments/wallet/:buyerId/top-up`, `/payments/:id/refund`.
- **Gateway** (`:4000`): UI web y API bajo `/api/*`; salud consolidada en `/api/system/health`.
- **Notificaciones** (`:3008`, prefijo `/api/v1`): bandeja, preferencias, historial y lectura de notificaciones.
- **Analítica** (`:3009`, prefijo `/api/v1`): `/analytics/sales`, `/analytics/waste`, `/analytics/inventory-rotation`, `/analytics/deliveries`, `/analytics/satisfaction` y `/analytics/reports` (administración).

Las acciones administrativas y rutas internas requieren autorización; no deben exponerse directamente a Internet sin las políticas previstas.

## Seguridad y archivos sensibles

- `.env`, llaves privadas RSA, contraseñas SMTP y cadenas de conexión no se versionan. Usar `.env.example` como plantilla, nunca como archivo de credenciales.
- Solo Identidad debe recibir `JWT_PRIVATE_KEY`; el resto de servicios necesita únicamente `JWT_PUBLIC_KEY`.
- `AUTH_EXPOSE_ACTION_TOKENS` debe permanecer desactivada en producción.
- No habilitar `AUTH_DISABLED` en producción.
- Revisar CORS, URL públicas y credenciales de RabbitMQ antes de desplegar.
- Certificaciones subidas por productores se guardan en almacenamiento local del servicio si no se integra un bucket persistente; el despliegue debe preservar esos archivos o migrarse a almacenamiento de objetos.

## Alcance académico y trabajo pendiente

`MOMENTO 1.pdf` propone nueve microservicios y el monorepo contiene los nueve servicios de backend, incluida Analítica. Ya hay E2E locales para ratings hacia Analítica y Notificaciones; quedan por probar otros contratos de eventos y respaldar snapshots iniciales de inventario con evidencia.

La guía pide repositorio por microservicio; actualmente este proyecto es un monorepo, y falta confirmar si el profesor lo admite. La app React Native del conductor requiere pruebas en dispositivo real y sincronización bajo red intermitente. Checkout/entregas completas-parciales-fallidas, calificaciones y eventos de Notificaciones/Analítica tienen E2E locales; aún faltan validar CI alojada, cerrar reconciliación y cobertura de eventos, agregar datos de demostración reproducibles, completar la documentación individual, revisar observabilidad/seguridad y verificar despliegues reales. No se deben presentar como realizadas pruebas, migraciones o despliegues que no tengan evidencia comprobable.

Las nuevas migraciones de Pagos, Pedidos y Logística se probaron únicamente en bases PostgreSQL efímeras locales; no se aplicaron a producción ni a Neon.

El archivo `FarmToTable_2_microservicios.md` conserva una especificación previa enfocada en Productores y Catálogo; no describe fielmente el alcance actual y debe tratarse como documento histórico hasta que sea actualizado.
