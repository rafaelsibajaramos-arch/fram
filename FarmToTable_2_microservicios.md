# FarmToTable --- Especificación de 2 Microservicios

## Productores + Catálogo y Cosechas

> Documento técnico de implementación basado en **MOMENTO 1.pdf ---
> FarmToTable: Arquitectura y modelamiento**.
>
> **Microservicios seleccionados:** 1. `producer-service` ---
> Productores, fincas y certificaciones. 2. `catalog-service` ---
> Categorías, productos, lotes de cosecha e historial de precios.
>
> Ambos usan **Node.js + NestJS + PostgreSQL independiente**, se
> comunican mediante **REST** para operaciones inmediatas y **RabbitMQ**
> para eventos asíncronos. Los servicios no deben compartir tablas ni
> acceder directamente a la base de datos del otro servicio.

------------------------------------------------------------------------

# 1. Objetivo

Implementar dos microservicios independientes para FarmToTable:

-   **Productores:** administrar productores, sus fincas y
    certificaciones.
-   **Catálogo y Cosechas:** administrar categorías, productos
    ofrecidos, lotes de cosecha y versiones de precios.

El microservicio de Catálogo depende funcionalmente de Productores
porque cada producto pertenece a un productor y cada lote de cosecha
pertenece a una finca. Sin embargo, la base de datos de Catálogo **no
tendrá FK hacia `producer_db`**. Las referencias externas se validan
mediante API o eventos.

La arquitectura general del documento original divide FarmToTable en
nueve microservicios y establece que cada servicio es dueño de sus
propios datos. REST se usa para respuestas inmediatas y RabbitMQ para
cambios que otros servicios procesan posteriormente.

------------------------------------------------------------------------

# 2. Tecnologías obligatorias/recomendadas

## 2.1. Backend

-   Node.js
-   NestJS
-   TypeScript
-   Prisma ORM
-   PostgreSQL
-   RabbitMQ
-   Docker
-   JWT para contexto de autenticación
-   Redis únicamente como caché del catálogo/disponibilidad cuando
    corresponda

## 2.2. Principios

-   Una base de datos por microservicio.
-   No hacer joins entre bases.
-   No permitir que un servicio escriba directamente en la base de otro.
-   Validar DTOs de entrada.
-   Operaciones importantes dentro de transacciones PostgreSQL.
-   Eventos idempotentes.
-   Contratos versionados.
-   `correlation_id` para rastrear operaciones distribuidas.
-   Las rutas internas no son públicas.
-   Las operaciones públicas pasan por el API Gateway.

------------------------------------------------------------------------

# 3. Estructura de proyectos

Se recomienda mantener los servicios separados:

``` text
farmtotable/
├── producer-service/
│   ├── src/
│   │   ├── producers/
│   │   ├── farms/
│   │   ├── certifications/
│   │   ├── events/
│   │   ├── common/
│   │   └── main.ts
│   ├── prisma/
│   ├── Dockerfile
│   └── package.json
│
├── catalog-service/
│   ├── src/
│   │   ├── categories/
│   │   ├── products/
│   │   ├── harvest-batches/
│   │   ├── prices/
│   │   ├── consumers/
│   │   ├── events/
│   │   ├── common/
│   │   └── main.ts
│   ├── prisma/
│   ├── Dockerfile
│   └── package.json
│
└── docker-compose.yml
```

Cada servicio debe poder levantarse y desplegarse de manera
independiente.

------------------------------------------------------------------------

# 4. Microservicio 1 --- Productores

## 4.1. Nombre

``` text
producer-service
```

## 4.2. Base de datos

``` text
producer_db
```

## 4.3. Responsabilidad

Este servicio es dueño de:

-   Perfiles de productores.
-   Fincas.
-   Certificaciones.

El documento establece que un productor puede tener varias fincas y cada
finca pertenece a un único productor. Si cambia el propietario de una
finca que ya tiene lotes, no se debe cambiar retroactivamente el
propietario: se desactiva la finca y se registra una nueva identidad.

Las certificaciones pertenecen al productor y no certifican
automáticamente cada finca.

------------------------------------------------------------------------

# 5. Módulos del Productor

## 5.1. `ProducersModule`

Responsable de:

-   Crear productores.
-   Consultar productores.
-   Actualizar perfiles.
-   Activar productores.
-   Desactivar productores.
-   Consultar productor por `user_id`.
-   Validar que un productor esté activo.
-   Validar propiedad de recursos.

## 5.2. `FarmsModule`

Responsable de:

-   Crear fincas.
-   Consultar fincas.
-   Actualizar información de una finca.
-   Activar/desactivar finca.
-   Validar que una finca pertenece al productor.
-   Validar coordenadas.
-   Obtener fincas activas de un productor.

## 5.3. `CertificationsModule`

Responsable de:

-   Crear certificaciones.
-   Consultar certificaciones.
-   Actualizar certificaciones.
-   Marcar certificaciones como revocadas.
-   Determinar si una certificación está vigente.
-   Consultar certificaciones por productor.

## 5.4. `EventsModule`

Responsable de publicar:

``` text
producer.created
producer.updated
producer.disabled
```

Y consumir:

``` text
identity.user_disabled
```

------------------------------------------------------------------------

# 6. Modelo de datos --- Productores

## 6.1. Tabla `PRODUCTORES`

Campos:

  Campo          Tipo             Obligatorio Regla
  -------------- -------------- ------------- ------------------------
  `id`           UUID                      Sí PK
  `user_id`      UUID                      Sí REF a Identity, UNIQUE
  `full_name`    varchar(150)              Sí No vacío
  `email`        varchar(254)              Sí Normalizado y UNIQUE
  `phone`        varchar(25)               No Validado
  `status`       varchar(12)               Sí `active` / `disabled`
  `created_at`   timestamptz               Sí `now()`

Restricciones:

``` text
UNIQUE(email)
UNIQUE(user_id)
INDEX(status)
```

### Importante

`user_id` identifica la cuenta autenticada.

`email` dentro de Productores es el correo de contacto comercial. El
correo de autenticación pertenece al microservicio de Identidad.

------------------------------------------------------------------------

# 7. Tabla `FINCAS`

Campos:

  Campo           Tipo             Obligatorio Regla
  --------------- -------------- ------------- -----------------------
  `id`            UUID                      Sí PK
  `producer_id`   UUID                      Sí FK local
  `farm_name`     varchar(120)              Sí No vacío
  `address`       text                      Sí Dirección de recogida
  `latitude`      numeric(9,6)              Sí -90 a 90
  `longitude`     numeric(9,6)              Sí -180 a 180
  `active`        boolean                   Sí Default `true`

Índice:

``` text
(producer_id, active)
```

Regla:

``` text
FINCAS.producer_id -> PRODUCTORES.id
```

No existe ninguna relación SQL directa con `catalog_db`.

------------------------------------------------------------------------

# 8. Tabla `CERTIFICACIONES`

Campos:

  Campo           Tipo            Obligatorio Regla
  --------------- ------------- ------------- -------------------------------
  `id`            UUID                     Sí PK
  `producer_id`   UUID                     Sí FK local
  `type`          varchar(60)              Sí No vacío
  `issue_date`    date                     Sí Fecha de expedición
  `valid_until`   date                     No NULL = sin caducidad
  `status`        varchar(12)              Sí `valid`, `expired`, `revoked`

Regla:

``` text
valid_until >= issue_date
```

Índice:

``` text
(producer_id, status, valid_until)
```

------------------------------------------------------------------------

# 9. Funciones del `producer-service`

## 9.1. Crear productor

``` http
POST /producers
```

Entrada:

``` json
{
  "user_id": "uuid",
  "full_name": "Juan Pérez",
  "email": "juan@example.com",
  "phone": "3000000000"
}
```

Validaciones:

-   `user_id` obligatorio.
-   `full_name` no vacío.
-   Email válido.
-   Email en minúsculas.
-   Eliminar espacios externos del email.
-   `user_id` no puede estar registrado previamente.
-   Email no puede estar registrado previamente.
-   La cuenta de Identity debe existir.
-   La cuenta debe estar autorizada para tener perfil de productor.

Resultado:

``` text
201 Created
```

Después del commit se publica:

``` text
producer.created
```

------------------------------------------------------------------------

# 9.2. Consultar productor

``` http
GET /producers/{id}
```

Debe devolver:

-   ID.
-   Nombre.
-   Email de contacto.
-   Teléfono.
-   Estado.
-   Fecha de creación.

No debe devolver información sensible de Identity.

------------------------------------------------------------------------

# 9.3. Listar productores

``` http
GET /producers
```

Filtros recomendados:

``` text
status
search
page
limit
```

Ejemplo:

``` http
GET /producers?status=active&search=carlos&page=1&limit=20
```

------------------------------------------------------------------------

# 9.4. Actualizar productor

``` http
PATCH /producers/{id}
```

Campos modificables:

``` json
{
  "full_name": "Carlos Pérez",
  "email": "carlos@example.com",
  "phone": "3010000000"
}
```

Validaciones:

-   El productor debe existir.
-   El productor debe pertenecer al usuario autenticado.
-   Email normalizado.
-   Email único.
-   No modificar `id`.
-   No modificar `user_id` mediante una actualización normal.

Publicar:

``` text
producer.updated
```

------------------------------------------------------------------------

# 9.5. Desactivar productor

``` http
PATCH /producers/{id}/disable
```

No eliminar físicamente el productor.

Cambiar:

``` text
status = disabled
```

Publicar:

``` text
producer.disabled
```

Este evento es importante porque Catálogo debe dejar de ofrecer
productos de productores dados de baja.

------------------------------------------------------------------------

# 9.6. Reactivar productor

``` http
PATCH /producers/{id}/enable
```

Debe existir una regla administrativa para permitir esta operación.

------------------------------------------------------------------------

# 9.7. Crear finca

``` http
POST /producers/{producerId}/farms
```

Entrada:

``` json
{
  "farm_name": "Finca La Esperanza",
  "address": "Vereda El Rosario",
  "latitude": 8.757000,
  "longitude": -75.890000
}
```

Validaciones:

-   Productor existente.
-   Productor activo.
-   Usuario autorizado.
-   Nombre no vacío.
-   Latitud entre -90 y 90.
-   Longitud entre -180 y 180.

------------------------------------------------------------------------

# 9.8. Listar fincas

``` http
GET /producers/{producerId}/farms
```

Filtros:

``` text
active=true
```

Debe permitir obtener únicamente fincas activas.

------------------------------------------------------------------------

# 9.9. Consultar finca

``` http
GET /farms/{farmId}
```

Respuesta mínima:

``` json
{
  "id": "uuid",
  "producer_id": "uuid",
  "farm_name": "Finca La Esperanza",
  "address": "Vereda El Rosario",
  "latitude": 8.757,
  "longitude": -75.89,
  "active": true
}
```

------------------------------------------------------------------------

# 9.10. Actualizar finca

``` http
PATCH /farms/{farmId}
```

Permitir modificar:

-   Nombre.
-   Dirección.
-   Coordenadas.

No permitir cambiar arbitrariamente `producer_id`.

Si la finca ya posee lotes, un cambio de propietario debe realizarse
mediante baja lógica y creación de una nueva identidad de finca.

------------------------------------------------------------------------

# 9.11. Desactivar finca

``` http
PATCH /farms/{farmId}/disable
```

Usar baja lógica:

``` text
active = false
```

No borrar físicamente la finca que pueda estar referenciada
históricamente.

------------------------------------------------------------------------

# 9.12. Crear certificación

``` http
POST /producers/{producerId}/certifications
```

Entrada:

``` json
{
  "type": "Orgánica",
  "issue_date": "2026-01-10",
  "valid_until": "2027-01-10"
}
```

Validaciones:

-   Productor existente.
-   `type` no vacío.
-   `valid_until >= issue_date`.
-   `status` inicial normalmente `valid`.

------------------------------------------------------------------------

# 9.13. Listar certificaciones

``` http
GET /producers/{producerId}/certifications
```

Filtros:

``` text
status
```

------------------------------------------------------------------------

# 9.14. Actualizar certificación

``` http
PATCH /certifications/{id}
```

Permitir:

-   Tipo.
-   Fecha de expedición.
-   Fecha de vencimiento.
-   Estado.

------------------------------------------------------------------------

# 9.15. Revocar certificación

``` http
PATCH /certifications/{id}/revoke
```

Cambiar:

``` text
status = revoked
```

No eliminar el registro porque forma parte del historial.

------------------------------------------------------------------------

# 10. Endpoint interno de validación

Catálogo necesita validar productores y fincas.

Se recomienda un endpoint interno:

``` http
GET /internal/producers/{producerId}/validate
```

Respuesta:

``` json
{
  "producer_id": "uuid",
  "exists": true,
  "active": true
}
```

Y para fincas:

``` http
GET /internal/farms/{farmId}/validate
```

Respuesta:

``` json
{
  "farm_id": "uuid",
  "exists": true,
  "active": true,
  "producer_id": "uuid"
}
```

Este endpoint:

-   No es público.
-   Requiere autenticación de servicio.
-   No debe exponerse desde Internet.
-   No debe devolver información innecesaria.

------------------------------------------------------------------------

# 11. Eventos del Productor

## 11.1. `producer.created`

Payload mínimo:

``` json
{
  "event_id": "uuid",
  "event_type": "producer.created",
  "source_service": "producer-service",
  "entity_id": "producer-uuid",
  "entity_version": 1,
  "schema_version": 1,
  "occurred_at": "2026-09-15T20:00:00Z",
  "correlation_id": "uuid",
  "payload": {
    "producer_id": "uuid",
    "user_id": "uuid",
    "full_name": "Juan Pérez",
    "status": "active"
  }
}
```

------------------------------------------------------------------------

# 11.2. `producer.updated`

Debe incluir:

-   `producer_id`.
-   `user_id`.
-   Versión de entidad.
-   Datos relevantes actualizados.

------------------------------------------------------------------------

# 11.3. `producer.disabled`

Payload mínimo:

``` json
{
  "producer_id": "uuid",
  "user_id": "uuid",
  "occurred_at": "2026-09-15T20:00:00Z"
}
```

Catálogo consume este evento para impedir que productos del productor
deshabilitado continúen publicados.

------------------------------------------------------------------------

# 11.4. `identity.user_disabled`

Productores consume este evento.

Cuando Identity desactiva una cuenta:

1.  Recibir evento.
2.  Buscar `PRODUCTORES.user_id`.
3.  Si existe, cambiar productor a `disabled`.
4.  Registrar la operación de manera idempotente.
5.  Publicar `producer.disabled`.

------------------------------------------------------------------------

# 12. Microservicio 2 --- Catálogo y Cosechas

## 12.1. Nombre

``` text
catalog-service
```

## 12.2. Base

``` text
catalog_db
```

## 12.3. Responsabilidad

Administra:

-   Categorías.
-   Productos.
-   Lotes de cosecha.
-   Historial de precios.
-   Disponibilidad publicada del catálogo.

El documento establece que todos los productos se venden en **kg**
dentro de este alcance.

El saldo real del inventario pertenece a `inventory_db`; Catálogo no
debe convertirse en la fuente definitiva del stock.

------------------------------------------------------------------------

# 13. Módulos del Catálogo

## 13.1. `CategoriesModule`

Funciones:

-   Crear categoría.
-   Listar categorías.
-   Consultar categoría.
-   Actualizar categoría.
-   Desactivar categoría si se requiere.
-   Evitar nombres duplicados.

## 13.2. `ProductsModule`

Funciones:

-   Crear producto.
-   Consultar producto.
-   Listar productos.
-   Filtrar productos.
-   Actualizar producto.
-   Activar/desactivar producto.
-   Validar productor.
-   Configurar mínimo de compra.
-   Configurar precio base.
-   Configurar umbrales de stock.

## 13.3. `HarvestBatchesModule`

Funciones:

-   Registrar lote.
-   Consultar lote.
-   Listar lotes por producto.
-   Listar lotes por finca.
-   Publicar lote.
-   Cerrar lote.
-   Validar finca.
-   Validar relación finca-productor-producto.

## 13.4. `PricesModule`

Funciones:

-   Consultar precio actual.
-   Consultar historial.
-   Crear nueva versión.
-   Cerrar versión anterior.
-   Calcular precio dinámico.
-   Recibir stock de Inventario.
-   Actualizar precio según umbral.

## 13.5. `InventoryConsumerModule`

Consume:

``` text
inventory.stock_changed
```

Su función es actualizar la información de disponibilidad usada por
Catálogo.

------------------------------------------------------------------------

# 14. Tabla `CATEGORIAS`

Campos:

  Campo    Tipo          Regla
  -------- ------------- ------------------
  `id`     UUID          PK
  `name`   varchar(80)   UNIQUE, no vacío

No deben existir categorías duplicadas.

------------------------------------------------------------------------

# 15. Tabla `PRODUCTOS`

Campos:

  Campo                    Tipo              Obligatorio Regla
  ------------------------ --------------- ------------- -------------------
  `id`                     UUID                       Sí PK
  `producer_id`            UUID                       Sí REF a Productores
  `name`                   varchar(150)               Sí No vacío
  `category_id`            UUID                       Sí FK local
  `unit`                   varchar(8)                 Sí Siempre `kg`
  `min_order_quantity`     numeric(12,3)              Sí \> 0
  `base_price`             numeric(14,2)              Sí \> 0
  `low_stock_threshold`    numeric(12,3)              Sí \>= 0
  `high_stock_threshold`   numeric(12,3)              Sí \> low
  `active`                 boolean                    Sí Default true

Índices:

``` text
(producer_id, active)
(category_id, active)
```

------------------------------------------------------------------------

# 16. Regla fundamental del precio

No crear:

``` text
current_price
```

como columna principal del producto.

El precio vigente se obtiene del historial de precios.

La tabla de historial es la autoridad sobre las versiones del precio.

------------------------------------------------------------------------

# 17. Tabla `LOTES_DE_COSECHA`

Campos:

  Campo               Tipo              Obligatorio Regla
  ------------------- --------------- ------------- -------------------------------------
  `batch_id`          UUID                       Sí PK
  `product_id`        UUID                       Sí FK local
  `farm_id`           UUID                       Sí REF a Productores
  `harvest_date`      date                       Sí Fecha de cosecha
  `quantity_kg`       numeric(12,3)              Sí \> 0
  `expiry_estimate`   date                       Sí \>= harvest_date
  `status`            varchar(12)                Sí `registered`, `published`, `closed`

Índices:

``` text
(product_id, expiry_estimate)
(farm_id, harvest_date)
```

`quantity_kg` es la cantidad inicial cosechada y no debe convertirse en
el saldo actual de inventario.

------------------------------------------------------------------------

# 18. Tabla `HISTORIAL_DE_PRECIOS`

Campos:

  Campo             Tipo            Regla
  ----------------- --------------- ------------------
  `id`              UUID            PK
  `product_id`      UUID            FK local
  `price`           numeric(14,2)   \> 0
  `valid_from`      timestamptz     Inicio inclusivo
  `valid_to`        timestamptz     NULL = actual
  `available_kg`    numeric(12,3)   \>= 0
  `stock_version`   bigint          \>= 0
  `reason`          varchar(20)     Valor controlado

Valores permitidos para `reason`:

``` text
initial
low_stock
normal_stock
high_stock
base_change
```

Restricciones:

``` text
UNIQUE(product_id, valid_from)
```

Y una única versión actual:

``` text
UNIQUE parcial(product_id) WHERE valid_to IS NULL
```

------------------------------------------------------------------------

# 19. Funciones del `catalog-service`

# 19.1. Crear categoría

``` http
POST /categories
```

Entrada:

``` json
{
  "name": "Frutas"
}
```

Validaciones:

-   No vacío.
-   Normalización de espacios.
-   Nombre único.

------------------------------------------------------------------------

# 19.2. Listar categorías

``` http
GET /categories
```

Debe devolver:

``` json
[
  {
    "id": "uuid",
    "name": "Frutas"
  }
]
```

------------------------------------------------------------------------

# 19.3. Crear producto

``` http
POST /products
```

Entrada:

``` json
{
  "producer_id": "uuid",
  "name": "Tomate",
  "category_id": "uuid",
  "unit": "kg",
  "min_order_quantity": 5,
  "base_price": 5000,
  "low_stock_threshold": 20,
  "high_stock_threshold": 100
}
```

Validaciones:

1.  Productor existe.
2.  Productor está activo.
3.  Categoría existe.
4.  Categoría es válida.
5.  `unit` debe ser `kg`.
6.  `min_order_quantity > 0`.
7.  `base_price > 0`.
8.  `low_stock_threshold >= 0`.
9.  `high_stock_threshold > low_stock_threshold`.

Al crear el producto debe crearse también una primera versión de precio:

``` text
reason = initial
```

------------------------------------------------------------------------

# 19.4. Consultar producto

``` http
GET /products/{id}
```

Debe incluir:

-   Producto.
-   Productor.
-   Categoría.
-   Precio vigente.
-   Versión de precio.
-   Disponibilidad conocida.

No debe consultar directamente `producer_db`.

Puede utilizar:

-   datos locales cacheados,
-   referencias externas,
-   o una consulta interna al Productor cuando sea necesaria.

------------------------------------------------------------------------

# 19.5. Listar productos

``` http
GET /products
```

Filtros:

``` text
producer_id
category_id
active
name
min_price
max_price
available
page
limit
```

Ejemplo:

``` http
GET /products?category_id=uuid&active=true&page=1&limit=20
```

------------------------------------------------------------------------

# 19.6. Productos disponibles

``` http
GET /products/available
```

Este endpoint es uno de los endpoints explícitos del documento.

Debe utilizar la disponibilidad recibida desde Inventario.

No debe inventar stock.

------------------------------------------------------------------------

# 19.7. Actualizar producto

``` http
PATCH /products/{id}
```

Campos:

``` text
name
category_id
min_order_quantity
base_price
low_stock_threshold
high_stock_threshold
active
```

Si cambia `base_price`, debe crearse una nueva versión de precio.

No se debe modificar directamente una versión histórica.

------------------------------------------------------------------------

# 19.8. Activar producto

``` http
PATCH /products/{id}/enable
```

Solo si:

-   Productor está activo.
-   Categoría válida.
-   Datos del producto completos.

------------------------------------------------------------------------

# 19.9. Desactivar producto

``` http
PATCH /products/{id}/disable
```

Debe ser baja lógica:

``` text
active = false
```

No eliminar el historial.

Publicar:

``` text
product.unavailable
```

------------------------------------------------------------------------

# 20. Registrar lote de cosecha

``` http
POST /harvest-batches
```

Entrada:

``` json
{
  "product_id": "uuid",
  "farm_id": "uuid",
  "harvest_date": "2026-09-15",
  "quantity_kg": 100,
  "expiry_estimate": "2026-09-25"
}
```

Validaciones:

1.  Producto existe.
2.  Producto está activo.
3.  Productor del producto está activo.
4.  Finca existe.
5.  Finca está activa.
6.  La finca pertenece al productor del producto.
7.  `quantity_kg > 0`.
8.  `expiry_estimate >= harvest_date`.

Si la finca no puede validarse, el lote no se publica.

------------------------------------------------------------------------

# 21. Publicar lote

``` http
PATCH /harvest-batches/{id}/publish
```

Cambiar:

``` text
status = published
```

Condiciones:

-   Producto activo.
-   Productor activo.
-   Finca válida.
-   Datos completos.

Publicar:

``` text
harvest.registered
```

El evento debe contener:

``` json
{
  "batch_id": "uuid",
  "product_id": "uuid",
  "farm_id": "uuid",
  "producer_id": "uuid",
  "quantity_kg": 100,
  "harvest_date": "2026-09-15",
  "expiry_estimate": "2026-09-25"
}
```

------------------------------------------------------------------------

# 22. Consultar lote

``` http
GET /harvest-batches/{id}
```

Debe devolver:

-   ID del lote.
-   Producto.
-   Finca.
-   Productor.
-   Fecha de cosecha.
-   Cantidad inicial.
-   Fecha estimada de vencimiento.
-   Estado.

La dirección de la finca no se debe duplicar dentro del catálogo.

------------------------------------------------------------------------

# 23. Listar lotes

``` http
GET /harvest-batches
```

Filtros:

``` text
product_id
farm_id
status
harvest_date
expiry_estimate
```

------------------------------------------------------------------------

# 24. Cerrar lote

``` http
PATCH /harvest-batches/{id}/close
```

Usar cuando el lote ya no debe considerarse una oferta nueva.

No borrar el lote.

------------------------------------------------------------------------

# 25. Precio vigente

``` http
GET /products/{id}/price
```

Respuesta:

``` json
{
  "product_id": "uuid",
  "price": 5500,
  "price_version_id": "uuid",
  "available_kg": 15,
  "stock_version": 12
}
```

Pedidos debe conservar el `price_version_id` que aceptó el comprador.

------------------------------------------------------------------------

# 26. Historial de precios

``` http
GET /products/{id}/prices
```

Debe devolver las versiones ordenadas por:

``` text
valid_from DESC
```

Ejemplo:

``` json
[
  {
    "id": "uuid",
    "price": 5500,
    "valid_from": "2026-09-15T10:00:00Z",
    "valid_to": null,
    "reason": "low_stock"
  },
  {
    "id": "uuid",
    "price": 5000,
    "valid_from": "2026-09-01T10:00:00Z",
    "valid_to": "2026-09-15T10:00:00Z",
    "reason": "initial"
  }
]
```

------------------------------------------------------------------------

# 27. Regla de precio dinámico

Los factores indicados en el documento son una decisión de diseño
configurable.

Regla:

``` text
Si stock < low_stock_threshold:
    precio = round(base_price * 1.10, 2)

Si stock > high_stock_threshold:
    precio = round(base_price * 0.90, 2)

En otro caso:
    precio = base_price
```

Ejemplo:

``` text
base_price = 5.000 COP/kg

stock = 10 kg
low_stock_threshold = 20 kg

precio = 5.000 × 1,10
precio = 5.500 COP/kg
```

------------------------------------------------------------------------

# 28. Actualización de precio

Cuando llega:

``` text
inventory.stock_changed
```

el servicio debe:

1.  Identificar el producto.
2.  Leer `available_kg`.
3.  Leer `stock_version`.
4.  Comparar con la última versión procesada.
5.  Ignorar eventos antiguos.
6.  Determinar el nuevo precio.
7.  Si el precio no cambia, actualizar disponibilidad si corresponde.
8.  Si cambia:
    -   bloquear producto;
    -   cerrar versión actual;
    -   crear nueva versión;
    -   realizarlo dentro de una transacción;
    -   publicar el cambio correspondiente.
9.  Nunca generar solapamiento entre versiones.

------------------------------------------------------------------------

# 29. Regla de versiones

Nunca debe existir:

``` text
version A: valid_to = NULL
version B: valid_to = NULL
```

para el mismo producto.

Debe existir máximo una versión vigente.

Ejemplo correcto:

``` text
v1
valid_from = 10:00
valid_to   = 12:00

v2
valid_from = 12:00
valid_to   = NULL
```

------------------------------------------------------------------------

# 30. Evento `inventory.stock_changed`

El Catálogo consume:

``` text
inventory.stock_changed
```

Datos mínimos:

``` json
{
  "product_id": "uuid",
  "stock_version": 15,
  "available_kg": 18,
  "physical_kg": 20
}
```

Regla:

``` text
si stock_version <= última versión procesada:
    ignorar evento
```

Esto evita regresar el catálogo a una disponibilidad antigua.

------------------------------------------------------------------------

# 31. Eventos publicados por Catálogo

## 31.1. `harvest.registered`

Consumidores:

-   Inventario.
-   Analítica.

Datos:

``` text
batch_id
product_id
producer_id
farm_id
harvest_date
quantity_kg
expiry_estimate
```

------------------------------------------------------------------------

## 31.2. `product.updated`

Consumidores posibles:

-   Notificaciones.
-   Analítica.
-   Otros consumidores que necesiten sincronizar información.

------------------------------------------------------------------------

## 31.3. `product.available`

Indica que el producto puede aparecer como oferta disponible.

------------------------------------------------------------------------

## 31.4. `product.unavailable`

Indica que el producto ya no debe aparecer como disponible.

------------------------------------------------------------------------

# 32. Outbox

Los eventos importantes no deben publicarse directamente desde el código
después de hacer un `INSERT` sin protección.

Usar patrón Outbox:

``` text
BEGIN TRANSACTION

guardar cambio de negocio
guardar evento en OUTBOX

COMMIT
```

Después un worker:

``` text
OUTBOX -> RabbitMQ
```

Esto evita que la base confirme una operación pero el evento no se
publique.

------------------------------------------------------------------------

# 33. Idempotencia

Los consumidores deben soportar mensajes duplicados.

Ejemplo:

``` text
inventory.stock_changed v10
inventory.stock_changed v10
```

El segundo evento no debe modificar nuevamente el estado.

Se puede guardar:

``` text
event_id
source_service
event_type
entity_id
entity_version
```

para detectar eventos ya procesados.

------------------------------------------------------------------------

# 34. Flujo completo Productor → Catálogo

## Paso 1

Identity crea/autoriza la cuenta.

## Paso 2

Productor crea su perfil:

``` text
POST /producers
```

## Paso 3

Productor crea una finca:

``` text
POST /producers/{id}/farms
```

## Paso 4

Productor crea un producto:

``` text
POST /products
```

Catálogo valida:

``` text
producer_id
```

contra Productores.

## Paso 5

Productor registra cosecha:

``` text
POST /harvest-batches
```

## Paso 6

Catálogo valida:

``` text
farm_id
producer_id
product_id
```

## Paso 7

Se publica:

``` text
harvest.registered
```

## Paso 8

Inventario recibe el lote y crea el inventario físico.

## Paso 9

Inventario publica:

``` text
inventory.stock_changed
```

## Paso 10

Catálogo actualiza disponibilidad.

## Paso 11

Catálogo calcula el precio dinámico.

------------------------------------------------------------------------

# 35. Flujo cuando se desactiva un productor

``` text
Identity
   |
   | identity.user_disabled
   v
Productor
   |
   | producer.disabled
   v
Catálogo
```

Catálogo debe:

1.  Recibir el evento.
2.  Identificar al productor.
3.  Dejar de ofrecer sus productos.
4.  No borrar productos históricos.
5.  Mantener la información necesaria para pedidos existentes.

------------------------------------------------------------------------

# 36. Autorización

## Productor

El usuario debe demostrar:

``` text
JWT.sub == PRODUCTORES.user_id
```

para modificar su propio perfil y recursos.

Un productor no puede modificar:

-   otro productor;
-   otra finca;
-   productos de otro productor;
-   certificaciones de otro productor.

## Administrador

Un `admin` puede gestionar cuentas según las reglas de Identity.

No debe obtener acceso a contraseñas o hashes.

------------------------------------------------------------------------

# 37. Endpoints finales --- Productor

``` text
POST   /producers
GET    /producers
GET    /producers/:id
PATCH  /producers/:id
PATCH  /producers/:id/enable
PATCH  /producers/:id/disable

POST   /producers/:id/farms
GET    /producers/:id/farms
GET    /farms/:id
PATCH  /farms/:id
PATCH  /farms/:id/enable
PATCH  /farms/:id/disable

POST   /producers/:id/certifications
GET    /producers/:id/certifications
GET    /certifications/:id
PATCH  /certifications/:id
PATCH  /certifications/:id/revoke

GET    /internal/producers/:id/validate
GET    /internal/farms/:id/validate
```

------------------------------------------------------------------------

# 38. Endpoints finales --- Catálogo

``` text
POST   /categories
GET    /categories
GET    /categories/:id
PATCH  /categories/:id

POST   /products
GET    /products
GET    /products/available
GET    /products/:id
PATCH  /products/:id
PATCH  /products/:id/enable
PATCH  /products/:id/disable

POST   /harvest-batches
GET    /harvest-batches
GET    /harvest-batches/:id
PATCH  /harvest-batches/:id
PATCH  /harvest-batches/:id/publish
PATCH  /harvest-batches/:id/close

GET    /products/:id/price
GET    /products/:id/prices
```

------------------------------------------------------------------------

# 39. DTOs mínimos

## ProductCreateDto

``` typescript
{
  producer_id: string;
  name: string;
  category_id: string;
  unit: "kg";
  min_order_quantity: number;
  base_price: number;
  low_stock_threshold: number;
  high_stock_threshold: number;
}
```

## FarmCreateDto

``` typescript
{
  farm_name: string;
  address: string;
  latitude: number;
  longitude: number;
}
```

## HarvestBatchCreateDto

``` typescript
{
  product_id: string;
  farm_id: string;
  harvest_date: string;
  quantity_kg: number;
  expiry_estimate: string;
}
```

## ProducerCreateDto

``` typescript
{
  user_id: string;
  full_name: string;
  email: string;
  phone?: string;
}
```

------------------------------------------------------------------------

# 40. Manejo de errores

Usar códigos HTTP coherentes:

``` text
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Unprocessable Entity
429 Too Many Requests
500 Internal Server Error
503 Service Unavailable
```

Casos específicos:

### 409

-   Email duplicado.
-   `user_id` ya asociado.
-   Categoría duplicada.
-   Versión de precio concurrente.
-   Operación duplicada.

### 404

-   Productor inexistente.
-   Finca inexistente.
-   Producto inexistente.
-   Lote inexistente.

### 422

-   Fechas inválidas.
-   Cantidad \<= 0.
-   Umbrales inconsistentes.
-   Coordenadas inválidas.

------------------------------------------------------------------------

# 41. Transacciones

## Productor

Usar transacción cuando:

-   Se crea productor + información relacionada.
-   Se actualiza productor y evento Outbox.
-   Se desactiva productor y evento Outbox.
-   Se modifica finca y se registra evento necesario.

## Catálogo

Usar transacción obligatoriamente cuando:

-   Se crea producto + primera versión de precio.
-   Se cambia precio.
-   Se cierra versión actual + abre nueva versión.
-   Se publica un lote + evento Outbox.
-   Se desactiva producto + evento Outbox.

------------------------------------------------------------------------

# 42. Caché Redis

Redis puede utilizarse para acelerar lecturas del catálogo.

Regla:

``` text
TTL = 30 segundos
```

La caché puede guardar:

``` text
product:{id}
products:available
product:{id}:price
```

Pero Redis **no es la fuente real del inventario**.

Si Redis falla:

``` text
Redis falla
   ↓
Catálogo consulta su fuente disponible
   ↓
La aplicación continúa
```

Nunca usar un contador de Redis para evitar sobreventa.

La reserva real pertenece al microservicio de Inventario.

------------------------------------------------------------------------

# 43. Seguridad

## No guardar

-   Contraseñas.
-   `password_hash` de Identity.
-   Refresh tokens.
-   Claves privadas.
-   Credenciales de PostgreSQL.
-   Credenciales RabbitMQ.

## Sí utilizar

-   HTTPS.
-   JWT.
-   Validación de DTOs.
-   CORS con orígenes exactos.
-   Rate limiting en Gateway.
-   Timeouts.
-   Autenticación de servicio para endpoints internos.
-   mTLS en comunicación interna cuando esté disponible.
-   Secretos mediante variables/secret manager.

------------------------------------------------------------------------

# 44. Logging

Todos los servicios deben registrar logs estructurados.

Ejemplo:

``` json
{
  "level": "info",
  "service": "catalog-service",
  "event": "harvest_registered",
  "entity_id": "uuid",
  "correlation_id": "uuid",
  "timestamp": "2026-09-15T20:00:00Z"
}
```

Nunca registrar:

``` text
password
password_hash
JWT
refresh_token
secret
```

------------------------------------------------------------------------

# 45. Health checks

Cada servicio debe tener:

``` http
GET /health
GET /health/ready
```

`/health`:

``` text
el proceso está funcionando
```

`/health/ready`:

``` text
PostgreSQL disponible
RabbitMQ disponible cuando sea necesario
dependencias esenciales disponibles
```

------------------------------------------------------------------------

# 46. Docker

Cada microservicio debe tener su propio:

``` text
Dockerfile
```

Ejemplo de servicios:

``` text
producer-service
producer-postgres

catalog-service
catalog-postgres

rabbitmq
redis
```

En producción las bases pueden ser servicios administrados y no
necesariamente contenedores del mismo Compose.

------------------------------------------------------------------------

# 47. Variables de entorno

## Productor

``` env
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://...
RABBITMQ_URL=amqp://...
JWT_PUBLIC_KEY=...
SERVICE_NAME=producer-service
```

## Catálogo

``` env
NODE_ENV=production
PORT=3002
DATABASE_URL=postgresql://...
RABBITMQ_URL=amqp://...
PRODUCER_SERVICE_URL=http://producer-service:3001
REDIS_URL=redis://...
SERVICE_NAME=catalog-service
```

Nunca colocar estos valores directamente en Git.

------------------------------------------------------------------------

# 48. Comunicación

## REST

Usar REST cuando se necesita respuesta inmediata.

Ejemplos:

``` text
Catálogo -> Productor
validar producer_id

Catálogo -> Productor
validar farm_id
```

## RabbitMQ

Usar RabbitMQ para eventos:

``` text
producer.created
producer.updated
producer.disabled
harvest.registered
product.updated
product.available
product.unavailable
inventory.stock_changed
```

------------------------------------------------------------------------

# 49. Contrato estándar de eventos

Todos los eventos deben tener:

``` json
{
  "event_id": "uuid",
  "event_type": "string",
  "source_service": "string",
  "entity_id": "uuid",
  "entity_version": 1,
  "schema_version": 1,
  "occurred_at": "timestamp",
  "correlation_id": "uuid",
  "payload": {}
}
```

No asumir que RabbitMQ entrega todos los eventos en orden global.

Cada consumidor debe controlar:

-   versión;
-   duplicados;
-   eventos antiguos;
-   errores;
-   reintentos.

------------------------------------------------------------------------

# 50. Pruebas que deben implementarse

## Productor

### Unitarias

-   Crear productor válido.
-   Rechazar email inválido.
-   Rechazar productor duplicado.
-   Validar coordenadas.
-   Crear finca.
-   Rechazar finca para productor inexistente.
-   Validar fechas de certificación.
-   Revocar certificación.

### Integración

-   PostgreSQL.
-   RabbitMQ.
-   Outbox.
-   `identity.user_disabled`.

### E2E

``` text
crear productor
→ crear finca
→ consultar finca
→ actualizar productor
→ desactivar productor
```

------------------------------------------------------------------------

# 51. Pruebas del Catálogo

### Unitarias

-   Crear categoría.
-   Rechazar categoría duplicada.
-   Crear producto.
-   Validar productor.
-   Validar categoría.
-   Validar `kg`.
-   Validar mínimos.
-   Validar umbrales.
-   Registrar lote.
-   Validar relación finca-productor.
-   Calcular precio dinámico.
-   Ignorar stock antiguo.

### Integración

``` text
Catalog -> Producer REST
Catalog <- RabbitMQ
Catalog -> PostgreSQL
Catalog -> Redis
```

### E2E

``` text
crear productor
→ crear finca
→ crear categoría
→ crear producto
→ registrar lote
→ publicar lote
→ recibir stock
→ actualizar precio
→ consultar producto disponible
```

------------------------------------------------------------------------

# 52. Criterios de aceptación

## Productor

El microservicio se considera terminado cuando:

-   [ ] Tiene PostgreSQL independiente.
-   [ ] Tiene CRUD de productores.
-   [ ] Tiene CRUD de fincas.
-   [ ] Tiene CRUD de certificaciones.
-   [ ] Usa bajas lógicas.
-   [ ] Valida `user_id`.
-   [ ] Valida propiedad de recursos.
-   [ ] Publica `producer.created`.
-   [ ] Publica `producer.updated`.
-   [ ] Publica `producer.disabled`.
-   [ ] Consume `identity.user_disabled`.
-   [ ] Usa Outbox.
-   [ ] Tiene pruebas.
-   [ ] Tiene Docker.
-   [ ] Tiene health check.

## Catálogo

-   [ ] Tiene PostgreSQL independiente.
-   [ ] Tiene CRUD de categorías.
-   [ ] Tiene CRUD de productos.
-   [ ] Tiene CRUD de lotes.
-   [ ] Tiene historial de precios.
-   [ ] Tiene `GET /products/available`.
-   [ ] Usa únicamente kg.
-   [ ] Valida productor.
-   [ ] Valida finca.
-   [ ] Implementa precio dinámico.
-   [ ] Consume `inventory.stock_changed`.
-   [ ] Ignora versiones antiguas.
-   [ ] Publica `harvest.registered`.
-   [ ] Publica `product.updated`.
-   [ ] Publica `product.available`.
-   [ ] Publica `product.unavailable`.
-   [ ] Usa Outbox.
-   [ ] Tiene Redis como caché opcional.
-   [ ] Tiene pruebas.
-   [ ] Tiene Docker.
-   [ ] Tiene health check.

------------------------------------------------------------------------

# 53. Lo que NO deben hacer estos microservicios

## Productor NO debe

-   Gestionar contraseñas.
-   Emitir JWT.
-   Gestionar pedidos.
-   Gestionar inventario.
-   Procesar pagos.
-   Gestionar rutas.
-   Consultar directamente `catalog_db`.
-   Consultar directamente `inventory_db`.

## Catálogo NO debe

-   Administrar contraseñas.
-   Administrar pedidos.
-   Reservar inventario.
-   Modificar saldos físicos.
-   Procesar pagos.
-   Acceder directamente a `producer_db`.
-   Usar Redis como fuente definitiva de stock.

------------------------------------------------------------------------

# 54. Arquitectura resumida

``` text
                    API Gateway
                         |
             +-----------+-----------+
             |                       |
             v                       v
     producer-service        catalog-service
             |                       |
             v                       v
       producer_db              catalog_db
             |                       |
             |                       |
             +------ RabbitMQ -------+
                         |
                         v
                inventory-service
```

Flujo principal:

``` text
Productor
   |
   v
producer-service
   |
   | productor/finca válidos
   v
catalog-service
   |
   v
harvest.registered
   |
   v
inventory-service
   |
   v
inventory.stock_changed
   |
   v
catalog-service
   |
   v
precio/disponibilidad
```

------------------------------------------------------------------------

# 55. Nota importante sobre el alcance

El PDF define nueve microservicios para FarmToTable. Este documento
selecciona únicamente **Productores** y **Catálogo y Cosechas** para
convertirlos en una especificación implementable.

Cuando el PDF proporciona explícitamente un endpoint, evento, tabla o
regla, se mantiene esa definición. Cuando se agregan endpoints CRUD
auxiliares para que los dos microservicios sean realmente utilizables,
estos se consideran **decisiones de implementación propuestas**, no
nuevos requisitos textuales del PDF.

Las reglas de precio dinámico `+10%` y `-10%` también deben considerarse
configurables, ya que el documento las presenta como una decisión de
diseño y no como una regla inmutable del negocio.

------------------------------------------------------------------------

# 56. Orden recomendado de implementación

## Fase 1 --- Productor

``` text
1. Crear NestJS
2. Configurar Prisma
3. Crear producer_db
4. Crear PRODUCTORES
5. Crear FINCAS
6. Crear CERTIFICACIONES
7. Crear CRUD
8. Agregar validaciones
9. Agregar autenticación
10. Agregar Outbox
11. Agregar RabbitMQ
12. Agregar eventos
13. Tests
14. Docker
```

## Fase 2 --- Catálogo

``` text
1. Crear NestJS
2. Configurar Prisma
3. Crear catalog_db
4. Crear CATEGORIAS
5. Crear PRODUCTOS
6. Crear LOTES_DE_COSECHA
7. Crear HISTORIAL_DE_PRECIOS
8. Crear CRUD
9. Integrar validación con Productor
10. Implementar precio dinámico
11. Implementar consumidor de stock
12. Implementar Outbox
13. Implementar eventos
14. Redis
15. Tests
16. Docker
```

## Fase 3 --- Integración

``` text
producer.created
producer.updated
producer.disabled
        |
        v
     RabbitMQ
        |
        v
catalog-service

catalog-service
        |
        v
harvest.registered
        |
        v
     RabbitMQ
        |
        v
inventory-service

inventory-service
        |
        v
inventory.stock_changed
        |
        v
catalog-service
```

------------------------------------------------------------------------

# 57. Resultado esperado

Al finalizar estos dos microservicios se debe poder realizar el
siguiente recorrido:

``` text
1. Crear cuenta de productor
2. Crear perfil de productor
3. Crear finca
4. Crear certificación
5. Crear categoría
6. Crear producto agrícola
7. Definir mínimo de compra
8. Definir precio base
9. Definir umbrales de stock
10. Registrar cosecha
11. Validar finca de origen
12. Publicar lote
13. Emitir harvest.registered
14. Recibir stock desde Inventario
15. Calcular disponibilidad
16. Calcular precio dinámico
17. Mostrar producto disponible
18. Mantener historial de precios
19. Desactivar productor cuando Identity lo solicite
20. Retirar sus productos de la oferta sin borrar la historia
```

Este alcance deja preparados los dos servicios para integrarse
posteriormente con **Pedidos, Inventario, Logística, Pagos,
Notificaciones, Analítica e Identidad**, respetando la arquitectura
definida para FarmToTable.
