# FarmToTable — `producer-service` + `catalog-service`

Implementación de los dos microservicios descritos en
[FarmToTable_2_microservicios.md](FarmToTable_2_microservicios.md): **Productores**
y **Catálogo y Cosechas**.

Cada servicio es dueño de sus propios datos, tiene su propia base PostgreSQL en
**Neon**, y se comunican por **REST** (respuestas inmediatas) y **RabbitMQ**
(eventos). No hay FK entre bases ni joins entre servicios.

```
                    API Gateway
                         |
             +-----------+-----------+
             |                       |
     producer-service  ---REST--->  catalog-service
             |                       |
        producer_db              catalog_db
          (Neon)                   (Neon)
             |                       |
             +------ RabbitMQ -------+
                         |
                 inventory-service
```

---

## 1. Estructura

```
projecto/
├── frontend/                  API Gateway + interfaz web             :4000
│   ├── server.mjs             gateway, Identidad simulada, Inventario simulado
│   └── public/                interfaz (HTML + CSS + módulos ES, sin build)
│
├── producer-service/          Productores, fincas, certificaciones   :3001
│   ├── prisma/schema.prisma   producer_db
│   └── src/
│       ├── producers/  farms/  certifications/
│       ├── internal/          rutas servicio-a-servicio
│       ├── events/            outbox, RabbitMQ, consumidor de Identity
│       └── common/            auth, config, filtros, correlation_id
│
├── catalog-service/           Categorías, productos, lotes, precios   :3002
│   ├── prisma/schema.prisma   catalog_db
│   └── src/
│       ├── categories/  products/  harvest-batches/  prices/
│       ├── consumers/         inventory.stock_changed, producer.*
│       ├── producer-client/   REST hacia producer-service
│       ├── cache/             Redis (solo caché de lectura)
│       └── events/  common/
│
├── docker-compose.yml         RabbitMQ + Redis + los dos servicios + gateway
└── .env.example
```

---

## 1.b. La interfaz

Con todo levantado, la aplicación está en **http://localhost:4000**.

El navegador habla **solo** con el gateway; nunca con `:3001` ni `:3002`. Eso evita
CORS, centraliza el `correlation_id`, aplica rate limiting y deja las rutas
`/internal/*` fuera del alcance público, tal y como describe la especificación
para el API Gateway.

El gateway hace además de **Identidad simulada** (emite el JWT que los dos
servicios verifican) y de **Inventario simulado** (publica
`inventory.stock_changed` en RabbitMQ). Son los dos microservicios que esta
entrega no implementa, y sin ellos no se podría ver el flujo completo.

Secciones:

| Sección | Qué hace |
| ------------- | ---------------------------------------------------------------------- |
| Flujo guiado  | ejecuta los 12 pasos del recorrido y muestra cada petición y respuesta |
| Productores   | alta, edición, baja, fincas y certificaciones                          |
| Categorías    | alta y desactivación                                                   |
| Productos     | alta, filtros, precio vigente e historial en línea de tiempo           |
| Cosechas      | registrar, publicar y cerrar lotes                                     |
| Simulador     | publicar `inventory.stock_changed` e `identity.user_disabled`          |
| Sistema       | salud de los servicios y estado de las colas de RabbitMQ               |

Para una demostración, **Flujo guiado → Ejecutar flujo completo** recorre todo
solo: crea productor, finca, certificación, categoría, producto y lote; publica
el lote; envía el stock por RabbitMQ y muestra el precio pasando de 5000 a 5500;
comprueba que un evento antiguo se descarta; y termina dando de baja al productor
para ver cómo el producto sale de la oferta sin perder el historial.

---

## 2. Puesta en marcha

### 2.1. Bases en Neon

Ya están creadas, una por microservicio, en proyectos **separados** para que cada
servicio tenga su propio cómputo y no comparta nada con el otro:

| Proyecto Neon          | ID                     | Base          | Servicio           |
| ---------------------- | ---------------------- | ------------- | ------------------ |
| `farmtotable-producer` | `small-queen-45996660` | `producer_db` | `producer-service` |
| `farmtotable-catalog`  | `damp-cell-24477908`   | `catalog_db`  | `catalog-service`  |

Si necesita recuperar las cadenas de conexión:

```bash
npx neonctl connection-string --project-id small-queen-45996660 --database-name producer_db --pooled
npx neonctl connection-string --project-id small-queen-45996660 --database-name producer_db
npx neonctl connection-string --project-id damp-cell-24477908  --database-name catalog_db --pooled
npx neonctl connection-string --project-id damp-cell-24477908  --database-name catalog_db
```

- **Pooled** (`-pooler` en el host) → `DATABASE_URL`, la que usa la aplicación.
- **Unpooled** (sin `-pooler`) → `DIRECT_URL`, la que usa `prisma migrate`.

### 2.2. Variables de entorno

Los archivos `.env` ya están escritos (raíz, `producer-service/` y
`catalog-service/`) con las cadenas de Neon y secretos generados al azar. No
están versionados: `.gitignore` los excluye. Las plantillas vacías quedan en los
`.env.example` por si hay que rehacerlos.

`INTERNAL_API_KEY` y `JWT_SECRET` son **iguales en los dos servicios**: el
primero es la clave con la que Catálogo llama a `/internal/*` de Productores, el
segundo es el secreto con el que ambos verifican el token de Identidad.

### 2.3. Migraciones

Ya aplicadas en las dos bases. Para repetirlas en otro entorno:

```bash
cd producer-service && npm install && npx prisma migrate deploy && npx prisma generate
cd ../catalog-service && npm install && npx prisma migrate deploy && npx prisma generate
```

La migración de Catálogo crea, además de las tablas, el índice único parcial que
garantiza **una sola versión de precio vigente** por producto:

```sql
CREATE UNIQUE INDEX ... ON historial_de_precios (product_id) WHERE valid_to IS NULL;
```

### 2.4. Levantar

Con Docker (levanta RabbitMQ, Redis, los dos servicios y la interfaz):

```bash
docker compose up -d --build
```

Y abra **http://localhost:4000**.

En local, sin Docker (necesita RabbitMQ y Redis escuchando):

```bash
cd producer-service && npm run start:dev    # http://localhost:3001
cd catalog-service  && npm run start:dev    # http://localhost:3002
cd frontend         && npm start            # http://localhost:4000
```

Comprobación:

```bash
curl http://localhost:3001/health/ready
curl http://localhost:3002/health/ready
curl http://localhost:4000/api/system/health
```

---

## 3. Endpoints

### `producer-service` (3001)

```
POST   /producers                          GET    /producers
GET    /producers/:id                      PATCH  /producers/:id
PATCH  /producers/:id/enable               PATCH  /producers/:id/disable
GET    /producers/by-user/:userId

POST   /producers/:id/farms                GET    /producers/:id/farms
GET    /farms/:id                          PATCH  /farms/:id
PATCH  /farms/:id/enable                   PATCH  /farms/:id/disable

POST   /producers/:id/certifications       GET    /producers/:id/certifications
GET    /certifications/:id                 PATCH  /certifications/:id
PATCH  /certifications/:id/revoke

GET    /internal/producers/:id/validate    ← solo servicio-a-servicio
GET    /internal/farms/:id/validate        ← solo servicio-a-servicio
GET    /health                             GET    /health/ready
```

### `catalog-service` (3002)

```
POST   /categories                         GET    /categories
GET    /categories/:id                     PATCH  /categories/:id

POST   /products                           GET    /products
GET    /products/available                 GET    /products/:id
PATCH  /products/:id                       PATCH  /products/:id/enable
PATCH  /products/:id/disable

POST   /harvest-batches                    GET    /harvest-batches
GET    /harvest-batches/:id                PATCH  /harvest-batches/:id
PATCH  /harvest-batches/:id/publish        PATCH  /harvest-batches/:id/close

GET    /products/:id/price                 GET    /products/:id/prices
GET    /health                             GET    /health/ready
```

---

## 4. Decisiones que conviene conocer

**El precio vigente no es una columna.** `PRODUCTOS` no tiene `current_price`; la
autoridad es `HISTORIAL_DE_PRECIOS`. La versión vigente es la que tiene
`valid_to IS NULL`, y el índice único parcial impide que existan dos.

**Precio dinámico configurable.** `stock < low → base × 1.10`,
`stock > high → base × 0.90`, en otro caso `base`. Los factores salen de
`LOW_STOCK_FACTOR` / `HIGH_STOCK_FACTOR`, porque el documento los presenta como
decisión de diseño, no como regla inmutable.

**Outbox en ambos servicios.** El cambio de negocio y el evento se guardan en la
misma transacción; un worker (`OutboxWorker`) los publica a RabbitMQ con
`FOR UPDATE SKIP LOCKED`, de modo que varias réplicas no dupliquen trabajo.

**Idempotencia.** Cada consumidor registra `event_id` en `processed_events` antes
de aplicar el efecto. Además, `inventory.stock_changed` con
`stock_version <= última procesada` se descarta: el catálogo nunca retrocede a
una disponibilidad vieja.

**Catálogo nunca toca `producer_db`.** Valida `producer_id` y `farm_id` por REST
contra `/internal/*`. Si Productores no responde, cae a la copia local
`producer_refs` (alimentada por los eventos `producer.*`); si tampoco hay copia,
responde `503` en lugar de adivinar.

**Bajas lógicas en todo.** Productores, fincas, certificaciones, productos y
lotes se desactivan, nunca se borran: los pedidos y el historial siguen
necesitando esos registros.

**Redis es solo caché** (TTL 30 s) de `product:{id}`, `product:{id}:price` y
`products:available`. Si Redis cae, el servicio sigue funcionando contra
PostgreSQL. Nunca se usa un contador de Redis para evitar sobreventa: la reserva
real pertenece a Inventario.

**Autorización.** Estos servicios no emiten JWT ni guardan contraseñas: verifican
el token de Identidad y comprueban `JWT.sub == PRODUCTORES.user_id` para los
recursos propios. `AUTH_DISABLED=true` desactiva el guard y existe solo para
desarrollo y pruebas locales.

---

## 5. Eventos

| Publica `producer-service` | Publica `catalog-service`                                                              |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `producer.created`         | `harvest.registered`                                                                   |
| `producer.updated`         | `product.updated`, `product.available`, `product.unavailable`, `product.price_changed`  |
| `producer.disabled`        |                                                                                        |

| Consume `producer-service` | Consume `catalog-service`                                      |
| -------------------------- | -------------------------------------------------------------- |
| `identity.user_disabled`   | `inventory.stock_changed`, `producer.created/updated/disabled`  |

Todos usan el mismo sobre:

```json
{
  "event_id": "uuid",
  "event_type": "harvest.registered",
  "source_service": "catalog-service",
  "entity_id": "uuid",
  "entity_version": 1,
  "schema_version": 1,
  "occurred_at": "2026-09-15T20:00:00Z",
  "correlation_id": "uuid",
  "payload": {}
}
```

Exchange `farmtotable.events` (topic, durable). Cada consumidor tiene su cola
durable con dead-letter queue: un mensaje que falla dos veces se aparta en
`<cola>.dead` para inspección manual en lugar de bloquear la cola.

---

## 6. Pruebas

```bash
npm test          # unitarias, sin base de datos (mocks de Prisma)
npm run test:e2e  # end-to-end, necesita DATABASE_URL apuntando a Neon
```

Estado actual: **142 pruebas en verde** contra las bases reales de Neon.

| Servicio           | Unitarias | E2E |
| ------------------ | --------- | --- |
| `producer-service` | 39        | 11  |
| `catalog-service`  | 78        | 14  |

Las E2E se saltan solas si no hay `DATABASE_URL`. Recorren el flujo completo:

- Productores: crear productor → finca → certificación → actualizar → desactivar.
- Catálogo: categoría → producto → lote → publicar → recibir stock → precio
  dinámico → producto disponible, comprobando que el historial de precios no se
  solape y que quede una sola versión vigente.

> Las E2E escriben en la base configurada y limpian lo que crean. Úselas contra
> una rama de Neon de desarrollo, no contra producción.

### Qué está verificado

Todo el sistema se probó levantado de verdad: los cuatro contenedores
(`docker compose up -d`), las dos bases de Neon, RabbitMQ y Redis.

```
SERVICE            STATUS
gateway            Up (healthy)   0.0.0.0:4000->4000
catalog-service    Up (healthy)   0.0.0.0:3002->3002
producer-service   Up (healthy)   0.0.0.0:3001->3001
rabbitmq           Up (healthy)   0.0.0.0:5672, 15672
redis              Up (healthy)   0.0.0.0:6379
```

```
GET /health/ready  producer -> {"postgres":"up","rabbitmq":"up"}
GET /health/ready  catalog  -> {"postgres":"up","rabbitmq":"up","redis":"up"}
```

Comprobado extremo a extremo, con mensajes reales pasando por el broker:

- **REST entre servicios.** Catálogo validó `producer_id` y `farm_id` contra
  `/internal/*` de Productores antes de crear el producto y el lote.
- **Outbox → RabbitMQ.** 3 eventos publicados por cada servicio, 0 pendientes,
  0 con error. Topología correcta: exchange `farmtotable.events` (topic), 3 colas
  durables con 1 consumidor cada una y su DLQ, 0 mensajes muertos.
- **Precio dinámico por evento.** Publicando `inventory.stock_changed` en el
  exchange: `available_kg=15` → **5000 → 5500** (`low_stock`);
  `available_kg=150` → **5500 → 4500** (`high_stock`); `available_kg=50` →
  **4500 → 5000** (`normal_stock`).
- **Eventos antiguos descartados.** Un `stock_version=5` posterior a un
  `stock_version=11` no movió nada.
- **Idempotencia.** El mismo `event_id` publicado dos veces no duplicó el efecto.
- **Historial sin solapamiento.** Cuatro versiones encadenadas
  (`valid_to` de cada una == `valid_from` de la siguiente), una sola vigente.
- **`producer.disabled` en vivo.** Al desactivar el productor, el evento viajó
  por RabbitMQ, Catálogo actualizó `producer_refs`, retiró el producto de
  `/products/available` y conservó historial y lotes.
- **Rechazos correctos.** `409` al registrar un lote con una finca de otro
  productor; `401` sin JWT; `403` al tocar el perfil ajeno; `401` en `/internal/*`
  sin `INTERNAL_API_KEY`.

- **La interfaz, extremo a extremo.** 35 comprobaciones contra el gateway en
  contenedor: archivos estáticos, `401` sin JWT, `404` al intentar alcanzar
  `/internal/*` por el gateway, el flujo completo de las siete vistas y la cadena
  `identity.user_disabled` → `producer.disabled` → producto retirado.

Los datos generados en esas pruebas se borraron: ambas bases quedaron en cero.

### Dos fallos de caché encontrados y corregidos

Probar la interfaz destapó el mismo síntoma dos veces: la base decía
`active: false` pero la API seguía respondiendo `active: true` durante 30
segundos. Eran dos causas distintas.

**1. Invalidación dentro de la transacción.** Al llegar `producer.disabled`, el
consumidor borraba las claves de Redis antes del `COMMIT`. Una lectura que
entrara en ese hueco volvía a escribir el producto todavía activo.
`disableAllByProducer` ya no toca la caché: devuelve los ids y el consumidor
invalida **después** del commit. Una prueba fija ese orden.

**2. Escritura obsoleta del patrón cache-aside.** Es la carrera clásica y
sobrevivía a la corrección anterior:

```
lectura:      get(miss) ── SELECT ──────────── set(valor viejo)  ← gana 30 s
escritura:              COMMIT ── del(clave) ─┘
```

La lectura ya había consultado PostgreSQL cuando llegó la invalidación, así que
guardaba un valor caducado. Ahora cada `del` deja una marca con su instante, y
`set` descarta la escritura si esa marca es posterior al momento en que empezó la
lectura. `CacheService` lo documenta y `cache.service.spec.ts` cubre ambos
sentidos de la carrera.

Verificado con tres corridas consecutivas de las 35 comprobaciones del gateway.

---

## 7. Flujo completo

```
1.  POST /producers                      (producer-service)
2.  POST /producers/:id/farms
3.  POST /categories                     (catalog-service)
4.  POST /products                       → valida producer_id por REST
5.  POST /harvest-batches                → valida farm_id y su dueño
6.  PATCH /harvest-batches/:id/publish   → outbox: harvest.registered
7.  inventory-service crea el inventario físico
8.  inventory.stock_changed              → catalog-service
9.  Catálogo actualiza disponibilidad y recalcula el precio
10. GET /products/available              → producto visible al precio vigente
```

Y cuando Identidad da de baja una cuenta:

```
identity.user_disabled → producer-service → producer.disabled → catalog-service
                                                                      ↓
                                          los productos se retiran de la oferta
                                          (sin borrar nada del historial)
```
