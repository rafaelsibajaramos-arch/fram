# Despliegue de FarmToTable en Railway Staging

> UPDATE 2026-10-18: Railway CLI authenticated; project `efficient-passion`; empty `staging` environment `22aeaccf-92ec-4035-aa55-97a9311cf872` was created after explicit authorization, with no duplication of `production`. CLI status confirms `Environment: staging`, `Linked service: None`, and no resources. No deployment, service, database, volume, or variable has been created there yet.

> Estado remoto verificado el 2026-10-18: CLI autenticado; el proyecto `efficient-passion` solo tiene el entorno `production`. Railway rechazó `staging` como inexistente. No crear ni clonar entornos hasta autorización expresa; en particular, no duplicar producción por el riesgo de copiar secretos o datos.

Este procedimiento es solo para el entorno de **staging** autorizado. No copiar variables, bases de datos, dominios ni credenciales de producción. Hay nueve bases PostgreSQL separadas, una por servicio Prisma; el `DIRECT_URL` de cada una debe apuntar a la misma base que su `DATABASE_URL`, no a la base de otro servicio.

## Servicios y configuración

En cada servicio de Railway establece el root directory y el config file path indicados. La configuración selecciona Dockerfile y health check; los nueve backends ejecutan `prisma migrate deploy` en pre-deploy. Gateway no tiene migraciones.

| Servicio | Root directory | Config file path | Readiness | Migración |
|---|---|---|---|---|
| producer-service | `/producer-service` | `/producer-service/railway.toml` | `/health/ready` | Sí |
| catalog-service | `/catalog-service` | `/catalog-service/railway.toml` | `/health/ready` | Sí |
| identity-service | `/identity-service` | `/identity-service/railway.toml` | `/health/ready` | Sí |
| inventory-service | `/inventory-service` | `/inventory-service/railway.toml` | `/health/ready` | Sí |
| payment-service | `/payment-service` | `/payment-service/railway.toml` | `/api/v1/health/ready` | Sí |
| order-service | `/order-service` | `/order-service/railway.toml` | `/api/v1/health/ready` | Sí |
| logistics-service | `/logistics-service` | `/logistics-service/railway.toml` | `/api/v1/health/ready` | Sí |
| notification-service | `/notification-service` | `/notification-service/railway.toml` | `/api/v1/health/ready` | Sí |
| analytics-service | `/analytics-service` | `/analytics-service/railway.toml` | `/api/v1/health/ready` | Sí |
| frontend (Gateway) | `/frontend` | `/frontend/railway.toml` | `/health/ready` | No |

## Infraestructura y variables

Antes de desplegar aplicaciones, crea en el entorno staging los nueve PostgreSQL, RabbitMQ y Redis. Inyecta las variables como referencias Railway de servicio privadas. La interfaz HTTP de cada backend debe hablar por red privada, no por dominio público. No imprimas ni guardes secretos en este archivo o en Git.

- En los nueve backends: `DATABASE_URL`, `DIRECT_URL`, `PORT`, `NODE_ENV=production`, `RABBITMQ_URL` y `RABBITMQ_EXCHANGE` según `.env.example` de cada servicio.
- Para migraciones, `DIRECT_URL` debe permitir conexión directa de escritura a la base PostgreSQL staging del mismo microservicio. Verifica el nombre de base antes del primer pre-deploy.
- Identity: par RSA exclusivo para staging (`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`), `JWT_ISSUER`, `JWT_AUDIENCE`; configura SMTP staging si se verificará recuperación de contraseña.
- Servicios que validan JWT: misma clave pública, issuer y audience que Identity. No mezclar claves de producción.
- Comunicación interna: genera `INTERNAL_API_KEY` exclusiva y coherente en los servicios que llaman rutas internas; define URL privada de cada upstream como muestra el `.env.example` del servicio.
- Catálogo y Gateway requieren Redis staging (`REDIS_URL`). El Gateway también requiere las URLs privadas de upstream y `GATEWAY_TRUST_PROXY` conforme a la topología Railway.
- Pagos debe usar `PLATFORM_COMMISSION_RATE=0.10`, congelada por línea. No configurar proveedores financieros reales: TerraWallet aquí es el ledger/saldo interno de staging.
- Configura variables opcionales de correo/SMS solo si hay credenciales de sandbox; nunca hagas pruebas de envío a listas reales.

## Orden de despliegue

1. PostgreSQL (9 bases), RabbitMQ y Redis del entorno staging; valida que cada servicio anuncie conexión privada.
2. Productor e Identity.
3. Catálogo e Inventario.
4. Pagos y Pedidos.
5. Logística, Notificaciones y Analítica.
6. Gateway/frontend al final, cuando sus upstreams ya respondan.

En cada microservicio observa el build, el comando pre-deploy, el arranque y el health check antes de pasar al siguiente. Un fallo de migración debe detener ese despliegue; no lo soluciones apuntando a otra base ni ejecutando SQL manual sin inspeccionar el error.

## Verificación y evidencia

1. Desde la raíz, ejecuta `node scripts/staging-health-smoke.mjs` con `TARGET_ENV=staging`, `STAGING_CONFIRMATION=I_UNDERSTAND_THIS_IS_STAGING`, `STAGING_BASE_URL` y `PRODUCTION_BASE_URL`. El smoke agregado es de solo lectura, exige HTTPS, rechaza el mismo origen de producción y falla si cualquiera de los nueve servicios no está listo. Comprueba además `GET /health/ready` del Gateway.
2. Revisa logs sin revelar valores de entorno: conexiones a Postgres/RabbitMQ/Redis, readiness y correlación de una solicitud de prueba.
3. Ejecuta primero smoke de lectura y autenticación. Checkout, recarga de saldo y carga k6 escriben datos; ejecútalos únicamente con cuentas, inventario y fondos de staging identificables como prueba.
4. `scripts/full-marketplace-local-e2e.mjs` está deliberadamente limitado a loopback y **no** se debe apuntar a Railway. Para pruebas remotas hace falta un smoke separado con guardas de staging, credenciales de prueba y presupuesto de saldo/inventario explícito.
5. Conserva URL/ID de deployment, commit, resultado de los diez health checks, resultado y duración de migraciones, correlation ID de smoke y captura de métricas. Redacta correos, tokens y URLs de conexión.

## Estado de preparación

- Los diez `railway.toml` ya existen y pasan parseo/validación local. Las imágenes de backend incluyen Prisma y migraciones; `npm audit --omit=dev` está limpio en los nueve.
- Railway CLI 5.70 informa que Config as Code se está retirando. Los TOML son puente únicamente para servicios existentes; antes de crear servicios nuevos o depender de esta configuración a largo plazo, enlaza el proyecto y revisa la conversión a `.railway/railway.ts` con `railway config migrate --variables unmanaged --show`. Esa conversión no pudo ejecutarse: la CLI confirmó que no hay proyecto enlazado. No ejecutes `railway config migrate cutover` ni `railway config apply` hasta revisar el diff/plan para staging y confirmar que no incluye cambios destructivos o de producción.
- Falta autenticar el CLI, enlazar proyecto/entorno staging, configurar servicios/variables, publicar una rama revisada y observar deployments. El último `railway whoami` devolvió `Unauthorized`; no hay acceso remoto confirmado.
- El worktree tiene cambios preexistentes mezclados y no debe publicarse con `git push` indiscriminado. Antes del push hay que revisar el diff completo, seleccionar los archivos propios del alcance, comprobar que `.env` y credenciales no estén staged, y mantener la rama fuera de `main`.
- El pre-deploy ejecuta una migración con escritura, por lo que nunca debe correr contra producción. Aunque el usuario autorizó staging, primero confirma en Railway que el environment seleccionado sea staging y que cada `DIRECT_URL` identifique su base de staging.
