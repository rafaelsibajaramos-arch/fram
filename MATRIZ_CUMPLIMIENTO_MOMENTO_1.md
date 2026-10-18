# Matriz de cumplimiento — MOMENTO 1

Auditoría del repositorio frente a `MOMENTO 1.pdf`. Esta matriz distingue entre código presente, pruebas observadas y trabajo aún pendiente. No afirma que Railway/Neon estén desplegados o validados.

## Estado ejecutivo

Railway access is now verified for project `efficient-passion`. An empty `staging` environment was created with explicit approval and linked locally; it contains no linked service or resources. Provisioning PostgreSQL, RabbitMQ, Redis, application services, variables, deploys, and remote migrations is still pending; no production changes were made.

- El monorepo contiene los nueve servicios propuestos: Productores, Catálogo, Pedidos, Inventario, Pagos, Identidad, Logística, Notificaciones y una primera implementación de Analítica.
- Notificaciones y Analítica tienen consumidores/outbox, pantallas iniciales y E2E locales para eventos de entrega, liquidación y calificaciones; quedan contratos por cubrir y proveedores externos por validar.
- Se añadió `driver-mobile`, app Expo/React Native con rutas asignadas, paradas, entregas, temperatura y outbox SQLite offline-first. Typecheck, 6 pruebas de flujo, exportación Android y Expo Doctor (21/21) pasan; aún necesita pruebas en dispositivo y reconciliación offline contra los servicios. La auditoría de npm mantiene hallazgos transitivos de Expo/Metro que requerirían cambios mayores para forzar su resolución.
- Hay gateway web/API propio; la propuesta Next.js/Vercel no está implementada y el cliente móvil no tiene APK/AAB distribuible.
- Los nueve backends tienen suites unitarias (214 aprobadas en la revalidación del 18-10-2026); frontend/Gateway aprobó 8 en la ejecución más reciente y `driver-mobile` 6, incluido typecheck y export Android. Hay E2E locales de Identity–Gateway, Catálogo–Redis, checkout/logística, rating–Analítica y Notificaciones. Falta observar los jobs en CI alojada y aumentar cobertura de eventos.
- La saga de checkout→despacho→entrega→liquidación tiene E2E HTTP reproducible sobre cuatro PostgreSQL y RabbitMQ efímeros; cubre rechazo compensado, concurrencia por última unidad, entregas completas/parciales/fallidas, respuesta HTTP perdida/reintento idempotente, DLQ tras un reintento acotado, redrive seguro desde DLQ, recuperación de un `order.created` durable al reiniciar Pedidos y persistencia de un mensaje en cola al reiniciar RabbitMQ. También valida que comprador, productor y admin consultan los detalles y dirección de la compra; comprueba aislamiento de pedidos entre compradores/productores. Falta observar CI y probar la app en dispositivo.
- La pila local aislada (nueve bases migradas, nueve servicios listos, Gateway/frontend HTTP 200) tiene smoke funcional de identidad/JWT/catálogo/pedidos/billetera/solicitud de productor y un E2E integral persistente: alta y aprobación de productor, finca, categoría, producto, cosecha, evento de stock, recarga TerraWallet, compra y consulta de los detalles por comprador/productor/admin, incluida la dirección, débito y consumo de inventario. CI alojada, pruebas en dispositivo y proveedores externos siguen pendientes.

## Leyenda

- **Parcial**: hay código relacionado, pero falta el contrato, comportamiento o evidencia requerida.
- **Pendiente**: no encontrado en el repositorio.
- **Revisar**: requiere una verificación de implementación o pruebas que no se puede inferir solo por nombres/rutas.

## Arquitectura y servicios

| Requisito del PDF | Situación observada | Estado | Criterio de cierre |
|---|---|---|---|
| Nueve servicios NestJS con PostgreSQL independiente | Hay nueve servicios NestJS con esquemas Prisma propios; migraciones de Notificaciones y Analítica probadas en Postgres temporal | Parcial | Cerrar contratos, migraciones y operación integral de los nueve servicios |
| Gateway público único; servicios privados e internos autenticados | Gateway Express valida sesiones en Identity; los ocho servicios de negocio validan el JWT RS256 firmado en vez de confiar en cabeceras `x-gateway-user-*`. El E2E prueba rechazo de roles/identidad falsificados. En Compose, Gateway es el único puerto accesible desde la red; servicios, RabbitMQ y Redis se publican en `127.0.0.1` para depuración local y se comunican por la red Docker | Parcial | Verificar y restringir la topología privada en el entorno desplegado; comprobar expiración/revocación y que URLs públicas directas de servicios no existan |
| REST síncrono + RabbitMQ asíncrono | REST presente; checkout asíncrono usa `order.created`, reservas, autorización, consumo y confirmación con outbox/inbox; E2E local automatizado cubre respuesta HTTP perdida con reintento idempotente, recuperación de evento pendiente tras reiniciar Pedidos, mensaje durable tras reiniciar RabbitMQ y redrive de DLQ con dry-run pasivo | Parcial | Observar el E2E en CI; probar reconciliación y la saga logística completa |
| Consistencia eventual, sin transacciones entre bases | Las tres rutas públicas de creación (`POST /orders`, `/checkout` y `/checkout/async`) convergen ahora en una saga durable: Order persiste pedido/outbox, Inventario reserva y Pagos autoriza/consume mediante eventos e inbox idempotente; el E2E integral usa la misma ruta asíncrona del carrito | Implementado localmente | Falta observar el mismo flujo en CI alojada y verificar reconciliación/operación en staging |
| Redis solo como caché de Catálogo, nunca autoridad de stock | Catálogo usa Redis solo para lecturas; `npm run test:e2e:redis-cache` comprueba contra Redis real TTL predeterminado de 30 s, expiración, invalidación de ficha/precio/listado y degradación cuando Redis no responde. `inventory.stock_changed` actualiza PostgreSQL y luego invalida las claves | Implementado y E2E local aprobado | Observar el job aislado de Redis en GitHub Actions y confirmar el SLA de disponibilidad/fallback en despliegue |
| Web Next.js/Vercel y app de transportistas React Native | Web actual es SPA del Gateway; `driver-mobile` usa React Native/Expo, login `driver`, rutas/paradas y sincronización por outbox SQLite | Parcial | Aclarar aceptación de SPA vs Next.js; probar en Android/iOS, red intermitente, actualización, almacenamiento y distribución |

## Dominios y contratos

| Dominio | Presente | Brecha principal para Momento 1 |
|---|---|---|
| Productores | `producer-service`: productores, fincas, certificaciones, eventos | Validar todos los campos/reglas del modelo, owner checks, roles y contrato de eventos con prueba de integración |
| Catálogo/Cosechas | `catalog-service`: productos, categorías, lotes, precios, consumidores | Verificar mínimos, kg/COP, historial, restricciones de esquema y consistencia de inventario; cubrir contratos e idempotencia |
| Pedidos | `order-service`: carrito, checkout, pedidos, consulta y calificación del comprador | Agrega líneas repetidas por producto; outbox estándar; ruta asíncrona persiste el pedido y confirma solo tras consumo/autorización; mantiene REST. Inbox de `order.fulfillment_closed` actualiza completo/parcial/fallido. Rating y `rating.created` son atómicos. E2E HTTP cubre compra, respuesta perdida/reintento idempotente, compensación, recuperación tras reinicio con `order.created` pendiente, dirección y estados entregado/parcial/cancelado; la carrera multilínea local valida cancelación del perdedor y compensación completa |
| Inventario | `inventory-service`: recepción, reservas, consumo/liberación, mermas | Reserva idempotente y transición condicional; consumo multi-producto atómico/idempotente; `order.created` asíncrono no duplica checkout REST ni acepta una reserva idempotente ya liberada. E2E local comprueba FEFO, compensación, despacho, carrera por última unidad y carrera multilínea con liberación de reservas parciales; movimientos/mermas aún requieren cobertura E2E |
| Logística/Rutas | `logistics-service`: API de zonas, conductores, vehículos, planes, rutas, paradas, entregas parciales y temperatura; outbox con eventos `fulfillment.plan_ready`, `delivery.*`, `cold_chain.alert` y `order.fulfillment_closed`; `driver-mobile` consume rutas y encola acciones offline con IDs idempotentes | Parcial: snapshot de `producer_id`; 11 unitarias y E2E verifican bloqueo de pago, ruta, paradas y cierres completo/parcial/fallido; faltan pruebas en dispositivo y reconciliación de cola |
| Pagos | `payment-service`: TerraWallet, top-ups, autorizaciones, pagos/reembolsos, libro de cobros y liquidaciones | Registra snapshot de líneas, captura solo lo aceptado, libera saldo restante, congela comisión global aprobada del 10% por línea, programa payouts, registra transferencias con referencia y crea ajustes de reembolso posteriores al pago. Incluye consulta por pedido protegida y bloqueo interno de autorización por ruta para impedir anulación durante el despacho. 23 unitarias y E2E validan cierre completo, parcial (captura 200 COP, devuelve 200 COP, payout neto 180 COP), fallido (void y devolución total) y reembolso posterior a transferencia con ajuste negativo diferido idempotente. |
| Notificaciones | `notification-service`: preferencias por tipo/canal, historial in-app/email/SMS, inbox, outbox, consumidor durable y worker de entrega; bandeja y preferencias accesibles desde el frontend | Parcial: 8 unitarias y E2E con RabbitMQ/PostgreSQL efímeros verifica eventos de comprador, conductor, productor y `rating.created`, replay idempotente y outbox. SMTP/SMS aún requieren credenciales/proveedor y prueba de envío externo |
| Analítica | `analytics-service`: inbox idempotente, proyecciones tipadas, fórmulas/unidades/periodo/zona/cobertura, endpoints de ventas/mermas/rotación/entregas/satisfacción y guardado de informes con outbox `report.generated`; dashboard admin inicial | Parcial: 9 unitarias y E2E PostgreSQL temporal valida reconstrucción transaccional, idempotencia, conservación de informes/outbox y rollback. E2E adicional recorre `rating.created` desde Pedidos por RabbitMQ hasta `rating_facts` y reporte protegido; falta E2E completo de otros productores de eventos y evidencia de snapshots iniciales de inventario |
| Identidad/Acceso | `identity-service`: login, sesiones, roles, correo y reset | El registro público crea solo buyer. Un comprador activo/verificado puede solicitar habilitación como productor; un administrador revisa y aprueba/rechaza, sin autoasignación, con cambio de rol, revocación de sesiones y evento `identity.roles_changed` atómicos. E2E HTTP a través del Gateway cubre solicitud duplicada, aprobación, rechazo, reenvío, verificación/login, rotación/replay de refresh y logout. Siguen pendientes pruebas de reset con SMTP real y despliegue/verificación de JWKS o red privada según topología final |

## Flujo principal de compra (saga)

| Paso exigido | Evidencia actual | Estado |
|---|---|---|
| Pedido publica `order.created` desde outbox | La ruta asíncrona persiste pedido y evento versionado/correlacionado; marcador `checkout_mode=async_saga` evita procesar el evento legado del checkout síncrono | Implementado; probado entre servicios localmente |
| Inventario reserva FEFO y publica resultado | Consumer `order.created` reserva por línea con clave determinista, snapshot de finca y compensación de reservas parciales; rechaza replays con reservas liberadas | E2E local valida redelivery, carrera multilínea y compensación; CI alojada pendiente |
| Pagos autoriza y publica resultado | Consumer de `inventory.order_reserved` valida suma y autoriza TerraWallet idempotentemente; rechazo definitivo genera compensación | Implementado; rechazo por saldo insuficiente validado localmente |
| Pedido confirma tras inventario y pago | Inbox guarda eventos de consumo y autorización; confirma solo cuando ambos están presentes | Implementado y probado entre servicios localmente |
| Logística crea plan y despacha tras confirmación | Consumer idempotente crea el plan; antes del despacho reserva en Pagos la autorización vinculándola al ID de ruta. Pagos valida `authorized`; el bloqueo impide la anulación concurrente y es idempotente por ruta | E2E local sobre APIs y bases efímeras valida migración, compra→ruta→despacho y rechazo de anulación; despliegue requiere configurar `PAYMENT_SERVICE_URL` e `INTERNAL_API_KEY` compartida |
| Entrega reporta cantidades realmente aceptadas | `PATCH /deliveries/:id/close` registra aceptación por reserva y valida `completed`/`partial`/`failed` | E2E local cubre los tres resultados y usuario driver; falta sincronización de la app en dispositivo |
| `order.fulfillment_closed` lleva cantidades aceptadas | Al terminar el plan publica kg e importes aceptados por línea desde snapshots de precio | E2E valida estados de pedido, captura y payout al productor en cierre completo/parcial, void al quedar en cero y reembolso posterior a una transferencia ya completada. |
| Pagos captura solo aceptado, hace void si cero y registra payout | Pagos registra detalles inmutables de pedido/línea, valida productor, cantidad, precio e importe al cierre; crea payout/item con comisión congelada y emite `payout.scheduled`; exige referencia para `payout.completed`; reembolso actualiza payout abierto o genera ajuste en periodo futuro si ya fue pagado | E2E local valida captura, devolución parcial, anulación por cero, payout y reembolso posterior al payout, incluyendo devolución TerraWallet, conservación de transferencia, ajuste neto diferido del 90% y reintento sin duplicados. Comisión aprobada: 10% global, congelada por línea (`PLATFORM_COMMISSION_RATE=0.10`). |
| Fallos compensan sin duplicar reservas/cobros | Reserva, autorización, consumo y reversión enlazados por outbox/inbox; claves deterministas; E2E local confirma pago/consumo, rechazo/liberación, respuesta HTTP perdida con reintento idempotente, replay `order.confirmed` sin duplicar plan, DLQ y redrive idempotente, recuperación de `order.created` pendiente tras reinicio de Pedidos y mensaje durable tras reinicio del broker. Un E2E mata al proceso real de Logística después del commit del inbox y antes del ACK, verifica `redelivered` y confirma que el reinicio no duplica plan ni entrega | Parcial: repetir el crash-gap en más consumidores y validar CI alojada |

## Plataforma, pruebas y seguridad

| Requisito | Situación observada | Estado |
|---|---|---|
| README, env de ejemplo y migraciones por servicio | Cada backend conserva su `prisma/migrations`; los nueve Dockerfiles runtime incluyen Prisma CLI y migraciones, con usuario `node`. Diez `railway.toml` especifican Dockerfile y readiness para Gateway/backends, y pre-deploy de migraciones para los nueve backends. Los TOML parsean; en las nueve imágenes se probó Prisma y las nueve bases locales aisladas reportaron esquema al día. | Parcial: enlazar cada servicio Railway staging a su root/config path y `DIRECT_URL` aislada; observar pre-deploy y despliegue real |
| Unitarias para reglas de dominio | Productores 40, Catálogo 80, Identidad 10, Inventario 12, Pedidos 21, Pagos 23, Logística 11, Notificaciones 8 y Analítica 9 (214 backend total); frontend/Gateway tiene 8 pruebas y `driver-mobile` 6. En la verificación local más reciente pasaron typecheck, lint, build y suites de los ocho servicios Jest; Pagos mantiene su gate Node ya verificado. Evidencia de reglas: `catalog-service/src/products/products.service.spec.ts`, `catalog-service/src/harvest-batches/harvest-batches.service.spec.ts`, `catalog-service/src/prices/{dynamic-price,prices}.spec.ts`, `inventory-service/src/inventory.service.spec.ts`, `order-service/src/orders.{domain,checkout,checkout-saga}.spec.ts`, `producer-service/src/{farms,producers}/`. |
| Integración con Postgres/RabbitMQ efímeros, Redis si aplica | E2E locales separados cubren checkout/logística, calificación→Analítica, eventos de Notificaciones, Identity→Gateway con sesión real sobre Postgres/RabbitMQ efímeros, Catálogo contra Redis real y recorrido de mercado completo sobre Compose persistente aislado | Parcial: faltan contratos E2E de otros productores y observar CI alojada |
| FEFO, mínimos, precio, redondeo, permisos, expiración de tokens | FEFO, reservas idempotentes/expiradas y consumo: `inventory-service/src/inventory.service.spec.ts` y E2E checkout; mínimos kg y validación de precio base/umbrales/unidad: `catalog-service/src/products/products.service.spec.ts`; FIFO/expiración de cosecha y publicación: `catalog-service/src/harvest-batches/harvest-batches.service.spec.ts`; umbral dinámico, límites exclusivos y redondeo decimal: `catalog-service/src/prices/dynamic-price.spec.ts`; ownership de finca/productor: `producer-service/src/farms/farms.service.spec.ts`, `producer-service/src/producers/producers.service.spec.ts`; refresh replay/revocación: E2E Identity–Gateway; acceso/roles falsificados: E2E checkout integral | Parcial: reglas cubiertas con pruebas unitarias/E2E locales, pero no hay una suite única que mapee todos los invariantes del PDF, ni pruebas de property/fuzzing; CI alojada y despliegue siguen pendientes |
| Concurrencia de última unidad, duplicados, compensaciones | E2E HTTP local: dos compradores compiten por 1 kg y solo una reserva queda activa; carrera multilínea prueba que la reserva previa del pedido perdedor se libera, no se debita saldo y solo se consume una unidad; incluye compensación por falta de saldo, reinicio de broker, respuesta perdida/reintento idempotente y redrive de DLQ | Checkout cubierto localmente; ampliar a más consumidores/escenarios y CI alojada |
| GitHub Actions CI/CD con build/test y promoción | `.github/workflows/ci.yml` instala, genera Prisma, ejecuta `tsc --noEmit`, ESLint, build y pruebas para los nueve backends; valida sintaxis web y typecheck/tests/export Android de `driver-mobile`, jobs E2E aislados y seis pruebas de guardarraíles del smoke de staging en `scripts/staging-health-smoke.test.mjs` | Parcial: no incluye despliegue/promoción; requiere push/PR para validar los jobs alojados |
| Carga k6 y umbrales | `tests/load/marketplace.js` reproduce rampa 20→100 VU, 70/20/10, HTTP<1%, p95 catálogo<500 ms, p95 pedidos<1.500 ms, confirmación<5 s, mínimo de 100 compras y guardarraíles explícitos de staging. CI inspecciona el script y comprueba que bloquea entorno inseguro/URL de producción igual sin generar carga | Parcial: k6 0.55.0, inspección y guardarraíles validados localmente; ejecución de carga y métricas no realizadas |
| Logs correlacionados, métricas y alertas | Logging/correlation IDs existentes; el Compose local aislado añade Prometheus, Blackbox Exporter y Grafana con probes de readiness/latencia, dos alertas y dashboard. No hay todavía métricas internas de negocio/infraestructura ni agregación centralizada de logs/alertas desplegada. | Parcial: observabilidad local verificada; instrumentación interna y despliegue en staging/producción pendientes |
| Seguridad: RS256, issuer/audience/exp, sesión revocada, ownership, rate limit, CORS, secretos | Gateway consulta Identity para verificar sesión activa/roles; los ocho servicios de negocio validan firma/issuer/audience y no aceptan identidad en cabeceras sin firma. Redis aplica rate limit atómico compartido con IP hasheada y TTL (prueba real con dos instancias); ante fallo hay fallback local acotado. El Gateway devuelve 429/`Retry-After`. Auditoría npm actual: los nueve backends reportan cero vulnerabilidades, también con dependencias de desarrollo; `driver-mobile` conserva 29 avisos reportados (18 altos, 11 moderados) en el árbol Expo/React Native. Las dependencias hoja observadas son `braces`, `decode-uri-component`, `node-forge` y `uuid`; no se impusieron downgrades/overrides incompatibles con el SDK y el riesgo del móvil sigue abierto. | Parcial: resolver o documentar con evidencia de alcance/remediación los avisos móviles; confirmar Redis, cadena proxy y topología privada en hosting; verificar expiración/revocación, CORS y secretos en el entorno final |
| Topología Render/Vercel especificada en PDF | Contexto existente usa Railway; no cambiar proveedor sin decisión del equipo/profesor | Diferencia de infraestructura, no prueba automática de defecto funcional |

## E2E integral del stack persistente local — 2026-10-18

- Se añadió `npm run test:e2e:full-marketplace-local`. La prueba impone URL loopback y confirma que Identity PostgreSQL es el contenedor `farmtotable-local-postgres-identity` enlazado exclusivamente a `127.0.0.1:15433`; usa una URL local fija y no lee `.env`.
- Recorre registro/verificación, aprobación administrativa de solicitud de productor, creación de perfil/finca/categoría/producto/lote, publicación y llegada del evento de cosecha a Inventario, recarga de TerraWallet y checkout HTTP real.
- Verifica pedido `confirmed`, nombre de producto/productor, dirección, consulta por comprador/productor/admin, existencia del pago, débito exacto al saldo y reducción del stock de 25 a 23 kg.
- Evidencia observada: PASS; pedido `3239c3d0-aa36-4d91-9023-b76380c08cd3`, total 2.000 COP. Los registros identificables de prueba permanecen en los volúmenes locales persistentes. Neon/Railway y el Compose original no se tocaron.

## Corte de verificación local y remoto — 2026-10-18

- Tests repetidos en esta revisión: backend 214/214; Gateway 8/8; guardarraíles de staging 6/6; caché de Catálogo contra Redis temporal 2/2 (TTL/expiración/invalidación y fallback sin Redis); smoke HTTP del stack local aislado 1/1; móvil typecheck + 6/6 + export Android. En esta pasada se volvieron a aprobar checkout/logística, Analytics rebuild, Notificaciones, rating→Analytics e Identity→Gateway sobre infraestructura efímera local. Docker build del Gateway y parseo local del workflow aprobados. Los ocho servicios Jest pasaron typecheck, lint, build y sus suites; los nueve backends reportan cero vulnerabilidades en auditoría completa y de producción. `driver-mobile` mantiene 29 avisos npm (18 altos, 11 moderados), sin resolución compatible confirmada para todo el árbol.
- Evidencia remota histórica de producción (GET de solo lectura de una revisión anterior): Productores, Catálogo, Pedidos y Pagos `ready`; Identity devolvió 503 por PostgreSQL `down`; Inventario excedió el timeout. Esto no describe ni verifica el estado remoto actual. La pila local aislada, en cambio, reportó los nueve servicios listos tras migraciones locales y el E2E integral aprobado. No se cambió Railway/Neon.
- No se realizó push ni se observó GitHub Actions; no existe configuración local de SMTP ni URL de staging, y no hay dispositivo/emulador Android disponible. Así que CI alojada, entrega real de correo, k6 en staging y sincronización móvil en dispositivo siguen sin probar.
- La solicitud del usuario autoriza Railway staging, no producción. El destino exacto (proyecto/entorno/servicios) no está disponible y `railway whoami` responde Unauthorized. La rama local es `codex/railway-staging-prep` con cambios locales mezclados (155 archivos modificados/no rastreados observados el 2026-10-18); no publicar todo el worktree ni desplegar antes de revisar diffs y confirmar que cada `DIRECT_URL` apunte exclusivamente a staging. Guía operativa: `RAILWAY_STAGING_RUNBOOK.md`.
- Revisión posterior de cobertura: se repitieron Catálogo (80/80), Inventario (12/12) y Pedidos (18/18); pasaron. Se confirmó evidencia específica para mínimos del producto y cosecha, precios dinámicos y redondeo, selección FEFO, replay/expiración de reservas y compensación/reanudación del checkout. Esto fortalece evidencia local, pero no sustituye pruebas de CI ni de staging.

## Orden de trabajo propuesto

1. **Base de entrega**: matriz de requisitos endpoint→servicio→prueba; estabilizar `npm ci`, builds y tests actuales; acordar si se mantiene Railway/SPA o se migra a Render/Vercel y si el profesor exige monorepo.
2. **Cierre del núcleo**: completar contratos de Identity, Inventory y Orders; implementar inbox/outbox uniforme y saga de autorización/reserva con compensaciones.
3. **Logística**: completar reprogramación auditable, endurecer app offline-first y probarla en dispositivo.
4. **Pagos completos**: el E2E local ya cubre reembolso posterior al payout; falta validar recuperación después de reinicio con eventos/outbox pendientes y observar la ejecución en CI alojada.
5. **Notificaciones y Analítica**: completar destinatarios/proveedores y pruebas E2E de ratings; cerrar proyecciones reconstruibles y su cobertura.
6. **Frontend**: paneles según roles, consulta legible de estado/pedido, direcciones y entregas, preferencias, analítica y experiencia móvil definida.
7. **Calidad y entrega**: CI, pruebas de integración/E2E/concurrencia, carga staging, observabilidad, docs por servicio y evidencia reproducible.

## Línea base local repetida — 2026-10-17

Comandos de compilación ejecutados: los seis microservicios originales y `logistics-service` terminaron con código 0 el 17-10-2026.

Pruebas ejecutadas:

| Servicio | Resultado actual |
|---|---|
| Productores | 4 suites, 39 tests aprobados |
| Catálogo | 8 suites, 79 tests aprobados |
| Identidad | 1 suite, 3 tests aprobados |
| Inventario | 1 suite, 9 tests aprobados; migraciones completas probadas en Postgres temporal |
| Pedidos | 4 suites, 10 tests aprobados; migraciones de outbox, estados, snapshot e inbox validadas en Postgres temporal |
| Pagos | 15 tests Node aprobados; migraciones de autorización/captura/anulación/liquidación probadas en Postgres temporal |
| Logística | 9 tests unitarios; build correcto; migraciones inicial/inbox/snapshot aplicadas en PostgreSQL 16 temporal |
| Gateway/Frontend | No hay script de pruebas |

No se ejecutaron pruebas E2E, despliegues ni migraciones remotas en esta auditoría. Las
migraciones nuevas de Inventario, Pedidos, Pagos y Logística se probaron únicamente contra contenedores PostgreSQL efímeros.

## Regla de ejecución segura

- Las migraciones y pruebas con escritura se ejecutan contra Postgres efímero/local o rama/base de desarrollo expresamente identificada; nunca contra producción por defecto.
- No se publican secretos, datos personales, tokens ni credenciales en commits/logs/capturas.
- La infraestructura de producción, proveedor cloud, cuentas y ramas remotas no se alteran como parte de esta auditoría.
- Un requisito solo se marca **Completo** cuando hay implementación y evidencia de prueba verificable.

## Documentación operativa por servicio — 2026-10-18

- Se agregaron guías `README.md` para Identidad, Productores, Catálogo, Inventario, Pedidos y Pagos, comparando rutas con controladores y comandos con los scripts existentes.
- La documentación base por servicio queda cubierta; la conformidad global aún es parcial por CI alojada, carga en staging, observabilidad, pruebas en dispositivo, SMTP/SMS reales y disponibilidad remota de Identity/Inventario.

## Incremento de CI — 2026-10-18

- Verificación local repetida con Prisma Client generado: nueve builds backend y 202 pruebas aprobadas; frontend pasó sintaxis JS y 2 pruebas; `driver-mobile` pasó typecheck, 6 pruebas y exportación Android. Los E2E locales cubren checkout/saga y reconstrucción de Analytics sobre PostgreSQL efímero. `npm ci --dry-run` aceptó los lockfiles de los 11 paquetes, pero no sustituye instalaciones limpias; aún falta validar `npm ci` desde checkout limpio y observar GitHub Actions alojado.

- Se verificó que `payment-service` usa `node --test`, mientras los otros ocho servicios usan Jest. El workflow no propaga el argumento Jest `--runInBand` a Pagos, evitando que ese runner reciba una opción incompatible.
- Verificación local del comando CI de Pagos: `npm test` compila el servicio y aprueba 17/17 pruebas.
- Pendiente: ejecutar el workflow alojado mediante push/PR; no se hizo push en este incremento.
- Se repitieron en local los gates de validación del workflow: los nueve backends compilaron; antes del incremento de checkout, las 182 pruebas backend aprobaron; Gateway aprobó 2 pruebas y toda su JavaScript pasó `node --check`; `driver-mobile` pasó typecheck, 6 pruebas y exportación Android.
- Aún no se considera CI alojada verificada: local no prueba el runner Linux de GitHub, instalación limpia con `npm ci`, caché ni permisos del workflow.

## Incremento de compensación de checkout — 2026-10-18

- Un rechazo definitivo de TerraWallet (HTTP 4xx, salvo 408/425/429) ahora cambia condicionalmente el pedido `pending` a `cancelled/failed`, escribe `order.cancelled` en la misma transacción y libera las reservas de Inventario. El cambio condicional evita sobrescribir una transición concurrente.
- Los errores transitorios (408/425/429, 5xx o timeout) conservan el pedido y sus reservas para repetir con la misma clave idempotente; no se libera stock cuando el resultado financiero puede ser ambiguo.
- Se añadió `GET /api/v1/payments/by-order/:orderId`, limitado al comprador dueño o admin. Si el POST de autorización pierde su respuesta, Pedidos busca una autorización ya persistida; si la encuentra continúa consumiendo inventario y confirma sin volver a debitar. Un 503 sin pago visible sigue pendiente/reintentable.
- `order-service`: build correcto y 17/17 pruebas; `payment-service`: build correcto y 19/19 pruebas, incluyendo la política de acceso a la consulta. La pasada completa actual de los nueve servicios aprobó 187/187 unitarias. No se ejecutó E2E con servicios/DBs separados.

## Revalidación del stack local y preparación de staging — 2026-10-18

- E2E integral repetido contra la pila Docker aislada (`127.0.0.1:14000`): pedido confirmado, débito de 2.000 COP, consumo de inventario, dirección y visibilidad comprador/admin/productor aprobados. Registro local: `f8b11135-893c-49c0-bf89-7daa6ef3b97e`.
- Gateway: 8/8 pruebas; guardarraíles del smoke staging: 6/6. Compose normal + overlay local pasa `docker compose config --quiet` al utilizar los placeholders locales requeridos; se corrigió el comentario del overlay para remitir al lanzador que configura esos valores y evita confundirlos con las URL reales de Neon. Los contenedores de la pila local usan mapeos loopback.
- La verificación remota sigue sin poder comenzar: `railway whoami` devuelve `Unauthorized`. No se realizó push, deploy, migración remota, ni se modificó producción. Railway staging, CI alojada, prueba k6 remota, entrega SMTP/SMS externa y prueba móvil en dispositivo permanecen pendientes.
