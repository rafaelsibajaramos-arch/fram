# Preparación de Railway para producción

Actualizado: 2026-10-18. El proyecto Railway es `efficient-passion`; el único entorno conservado es `production` (`d7ea24be-db50-41a1-8f3c-c11e627eb6f6`). El entorno `staging` fue eliminado por solicitud del propietario.

## Servicios

Producción ya tiene Gateway (`fram`), Identity, Producer, Catalog, Inventory, Order, Payment y RabbitMQ. La consulta de Railway mostró Inventory como `CRASHED` y detenido. No se modificó ni reinició.

Se crearon tres servicios productivos y se cargó en cada uno una imagen construida desde su carpeta local. No se creó ningún dominio ni se configuraron secretos:

| Servicio | ID Railway | Root directory | Config file |
|---|---|---|---|
| `logistics-service` | `afeab592-535c-45a8-b663-1762f09a796e` | `/Dockerfile` (código subido desde `logistics-service`) | `/api/v1/health/ready`; `npm run prisma:deploy` |
| `notification-service` | `70fd3f3d-4b50-4bbb-b80b-f23fb65a002e` | `/Dockerfile` (código subido desde `notification-service`) | `/api/v1/health/ready`; `npm run prisma:deploy` |
| `analytics-service` | `1b821399-5ba3-4c66-946c-3f8340e36dee` | `/Dockerfile` (código subido desde `analytics-service`) | `/api/v1/health/ready`; `npm run prisma:deploy` |

Builds cargados el 2026-10-18: Logística `2c3340ee-2138-4edd-a037-bba333fca44f`, Notificaciones `2a083ce1-4bdf-473a-aef9-ef438fe0662e` y Analítica `a34784fc-57b4-4b46-b660-ff4d9ccf8648`. Los tres compilaron con Docker y llegaron al pre-deploy; fallaron con Prisma `P1012` porque todavía no existe `DIRECT_URL`. No se conectaron a Neon ni se aplicaron migraciones. Su fuente actual es la última carga local, no GitHub: cambios futuros en el repo no se desplegarán automáticamente hasta publicar y conectar una rama aprobada.

## Variables pendientes

Crear en Neon una base separada por servicio (no reutilizar entre microservicios). Para cada base usar URL pooled en `DATABASE_URL` y URL directa en `DIRECT_URL`, ambas de la misma base. Los pre-deploy de los nueve backends ejecutan `prisma migrate deploy`: ingresar URLs puede iniciar un despliegue que escribe el esquema. Revisar las migraciones y respaldos antes de permitir esa ejecución.

- Logística: `DATABASE_URL`, `DIRECT_URL`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `INTERNAL_API_KEY`, `PAYMENT_SERVICE_URL`, `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`. Opcionales con valor por defecto: `COLD_CHAIN_MAX_C`, `DELIVERY_WINDOW_START_DAYS`, `DELIVERY_WINDOW_END_DAYS`, `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE`.
- Notificaciones: `DATABASE_URL`, `DIRECT_URL`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `INTERNAL_API_KEY`, `IDENTITY_SERVICE_URL`, `PRODUCER_SERVICE_URL`, `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`. Para correo real también `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`; SMS es opcional (`SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`).
- Analítica: `DATABASE_URL`, `DIRECT_URL`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`.
- En los tres servicios, `PORT` debe dejarse al puerto inyectado por Railway; el código tiene fallback 3007/3008/3009. No se debe agregar `JWT_PRIVATE_KEY` a servicios distintos de Identity.
- Después de que los tres tengan dominio privado, Gateway necesita `LOGISTICS_SERVICE_URL`, `NOTIFICATION_SERVICE_URL` y `ANALYTICS_SERVICE_URL` apuntando a los dominios privados respectivos. No se tocaron las variables del Gateway para evitar un redeploy prematuro.

## Pasos restantes

1. Publicar/revisar los directorios nuevos en una rama aprobada y conectar esa rama si se requiere despliegue automático desde GitHub. Las imágenes cargadas actualmente son snapshots locales.
2. Conectar las tres bases Neon independientes y las referencias privadas a RabbitMQ, Payment, Identity y Producer; compartir la misma clave pública JWT, issuer/audience y clave interna donde corresponda.
3. Configurar Gateway con los tres dominios privados y comprobar la configuración antes de desplegarlo.
4. Revisar y autorizar las migraciones de Neon; al redeplegar, Railway ejecutará `prisma migrate deploy`. Validar `/api/v1/health/ready` después de migrar.
5. Diagnosticar por separado el deployment de Inventory detenido y el estado de disponibilidad/cuota de Neon. No se hicieron cambios ni migraciones en las bases existentes.

No guardar valores secretos en este documento ni en Git. El contenido es una lista de nombres y topología, no contiene credenciales.
