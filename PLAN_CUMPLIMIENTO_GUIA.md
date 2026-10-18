# Plan para completar la entrega de Arquitectura y Modelamiento

## Alcance

Este inventario organiza lo que ya existe antes de construir servicios nuevos.
El repositorio contiene nueve microservicios (`producer`, `catalog`, `identity`,
`inventory`, `order`, `payment`, `logistics`, `notification`, `analytics`) y `frontend`. `MOMENTO 1.pdf` propone nueve
microservicios. Notificaciones y Analítica tienen primeras implementaciones locales, pero
ambas siguen parciales y requieren integración E2E. Logística
ya tiene un backend y ahora cuenta con un primer cliente Expo/React Native offline-first; siguen pendientes pruebas en dispositivo y conexión completa a la saga.
El documento `FarmToTable_2_microservicios.md` aún describe una entrega
anterior enfocada solo en Productores y Catálogo, por lo que debe actualizarse cuando
se confirme el alcance que calificará el profesor.

La auditoría requisito por requisito está en `MATRIZ_CUMPLIMIENTO_MOMENTO_1.md`.
El objetivo de trabajo es completar todo `MOMENTO 1.pdf`, sin confundir código
presente con comportamiento probado. La saga de compra y liquidación ya tienen E2E
locales aislados; siguen faltando evidencias de ejecución alojada, despliegue y pruebas
con proveedores/dispositivos reales. El trabajo se hará por etapas, con pruebas y
migraciones de escritura solo en infraestructura local/efímera o de desarrollo
identificada, nunca en producción por defecto.

## Verificación local realizada

Repetida el 18-10-2026. El stack local aislado se levantó con nueve PostgreSQL
independientes, RabbitMQ, Redis, los nueve servicios, Gateway y frontend. Se aplicaron
las nueve cadenas de migraciones únicamente a las bases locales; todos los servicios
quedaron healthy y Gateway/frontend respondieron HTTP 200.

- Las nueve suites backend aprobaron 211 pruebas unitarias: Productores 40, Catálogo
  80, Identidad 10, Inventario 12, Pedidos 18, Pagos 23, Logística 11, Notificaciones 8
  y Analítica 9. Frontend/Gateway aprobó 8 pruebas en la última ejecución; `driver-mobile` aprobó 6.
- E2E locales con contenedores aislados aprobaron checkout/logística (incluye comisión
  global 10%), identidad a través del Gateway, reconstrucción y calificación en
  Analítica, Notificaciones y Catálogo/Redis. Smoke adicional del stack persistente local
  verificó registro/confirmación/login, JWT, catálogo, pedidos y billetera, además del
  rechazo de autoasignación del rol productor.
- No se ejecutaron migraciones remotas, despliegues ni pruebas contra Railway/Neon.
- SMTP/SMS reales, carga en staging y pruebas en dispositivos móviles todavía requieren
  sus respectivos proveedores, ambiente y dispositivos; compilar/probar local no los
  acredita.

## Pendientes sobre lo ya construido

| Área | Estado observado | Trabajo para cerrar |
|---|---|---|
| Implementación | Nueve servicios existen; el baseline de siete se verificó el 17-10-2026. Notificaciones y Analítica se compilaron/probaron y sus migraciones se aplicaron localmente el 18-10-2026. | Probar flujos completos y validar permisos, errores y dependencias entre servicios con datos de prueba. |
| Saga de checkout/entrega | Ruta asíncrona con eventos durables outbox/inbox: pedido pendiente → reservas atómicas → autorización TerraWallet → consumo de stock → confirmación; fallos definitivos cancelan y compensan. Comisión global predeterminada 10%, congelada por línea al registrar el detalle del cobro. Migraciones validadas en Postgres efímero. | E2E HTTP local con Docker cubre entrega completa/parcial/fallida, replay idempotente, respuesta HTTP descartada tras commit y reintento con la misma clave, reintento→DLQ y redrive probado, recuperación de `order.created` tras reiniciar Pedidos y persistencia de mensaje al reiniciar RabbitMQ. |
| Eventos de Pedidos/Pagos | Outbox durable e inbox para cierre logístico; Pedidos actualiza la entrega y Pagos captura/libera saldo. El despacho reserva idempotentemente la autorización por ruta. E2E local cubre compra→ruta→entrega completa/parcial/fallida→captura/void→payout, replay idempotente, respuesta HTTP perdida y dead-letter routing. Redrive seguro de DLQ ya tiene herramienta y prueba local aislada. | Pendiente validar CI alojada. Ninguna migración se aplicó a producción. |
| Identidad e Inventario | El stack de desarrollo local está healthy con sus PostgreSQL aislados; la disponibilidad de Neon/Railway no se comprobó en esta pasada. | Validar las bases y servicios desplegados cuando se autorice/acuerde esa comprobación; no inferir cuota o disponibilidad remota a partir del entorno local. |
| Pruebas | Verificación local del 18-10: 211 unitarias backend en nueve servicios, 6 frontend y 6 `driver-mobile`; E2E reproducibles de checkout/logística, identidad/Gateway, Analytics, rating, notificaciones y Redis. También smoke funcional contra stack local completo. | Ejecutar `npm ci` en runner Linux y CI alojada; probar UI en navegador/dispositivo y completar el checkout sembrado de extremo a extremo en el stack persistente local. |
| Consumidores de eventos | Pagos y Pedidos consumen `order.fulfillment_closed`; Inventario, Pagos, Pedidos y Logística consumen eventos de checkout/orden mediante colas durables e inbox/outbox. E2E comprobó replay idempotente, reintento con envío a DLQ, redrive operativo desde DLQ, respuesta HTTP perdida tras persistir el checkout, publicación/confirmación de outbox tras reiniciar Pedidos, persistencia de `order.created` al reiniciar RabbitMQ y crash-gap real del consumidor de Logística entre commit del inbox y ACK. | Validar conectividad de despliegue antes de atribuir fallas al código; extender crash-gap a más consumidores. |
| Migraciones | Las nueve cadenas Prisma se aplicaron al Compose aislado; las imágenes runtime contienen CLI y migraciones, y las nueve bases locales reportaron `migrate status` al día. Se añadieron comandos pre-deploy para staging en los nueve `railway.toml`. | Aplicar y observar el pre-deploy contra las nueve bases staging privadas; nunca ejecutar contra producción. |
| Datos de demostración | No se encontró una estrategia de seed uniforme en los manifiestos revisados. | Crear datos de demostración reproducibles, sin cuentas ni credenciales reales. |
| Variables de entorno | Hay plantillas de ejemplo para los nueve servicios y variables para Notificaciones/Analítica. | Completar las URL reales de cada base en el entorno de desarrollo/despliegue; SMTP/SMS requieren configuración externa. |
| CI | Workflow de GitHub Actions para `npm ci`, Prisma generate, build y pruebas unitarias de los nueve servicios; valida sintaxis/pruebas web y typecheck/tests/export Android del cliente móvil. Se corrigió que Node test de Pagos no reciba `--runInBand`; gates equivalentes ejecutados localmente con éxito el 18-10. | Requiere push/PR para confirmar el runner Linux y la instalación limpia; faltan CI de integración y despliegue/promoción controlados. |
| Documentación | README raíz y README en los nueve servicios documentan endpoints/configuración; `RAILWAY_STAGING_RUNBOOK.md` enumera roots, config paths, readiness, migraciones y pasos de staging. | Contrastar el runbook con el environment y variables reales de Railway; adjuntar evidencia del despliegue. |
| Repositorios | Los nueve servicios están dentro de un solo repositorio Git. | La guía solicita un repositorio por microservicio: confirmar si el profesor admite monorepo; si exige separación, planear publicación sin perder historial. |
| Despliegue | El contexto muestra servicios desplegados en Railway, pero no se validaron aquí URLs, salud, variables ni acceso a bases remotas. | Adjuntar URL y evidencia de `/health/ready` por servicio, estado de base y prueba de flujo; no publicar valores secretos. |
| Historial de trabajo | Existe historial Git en el repositorio. | Asociar commits/tareas con cada integrante según lo que pide la guía; no inventar autorías retrospectivas. |
| Arquitectura vs. aplicación | Momento 1 y el monorepo ya coinciden en nueve servicios; permanecen diferencias en la saga asíncrona y el cliente móvil. | Hacer una matriz requisito→servicio→endpoint→prueba y resolver esas diferencias antes de presentar cumplimiento. |

## Evidencia incremental (18-10-2026, actualización)

- El E2E `npm run test:e2e:checkout` ahora recorre compra, despacho y tres cierres: completo, parcial y fallido, usando cuatro PostgreSQL y RabbitMQ efímeros locales. Verifica pedido `delivered`/`partial`/`cancelled`, captura solo lo aceptado, devolución de saldo no aceptado, `void` y ausencia de payout cuando no se acepta producto.
- Caso parcial comprobado: se autoriza 400 COP, se aceptan 2 kg por 200 COP, se devuelve 200 COP al comprador y se liquida 180 COP al productor después de la comisión global congelada del 10%.
- Caso fallido comprobado: se devuelven los 400 COP, el pedido queda cancelado, el pago se anula y no se crea liquidación.
- El E2E publica de nuevo el mismo `order.confirmed`: la inbox conserva un solo evento, plan y entrega. También inyecta un evento inválido y verifica que el consumer de Logística lo envía a su DLQ después de un reintento. Ejecución local finalizó con código 0.
- El E2E verifica el operador de redrive: dry-run pasivo sin cambios y republicación confirmada de un evento válido desde la DLQ; la inbox de Logística evita duplicar evento, plan y entrega. Ejecución local finalizó con código 0. La herramienta opera al menos una vez y no se ejecutó contra infraestructura externa.
- El E2E simula la pérdida de la respuesta HTTP después de que Pedidos ya confirmó internamente el `201`; el reintento con la misma clave recupera el mismo pedido y deja un solo `order.created`, reserva consumida, autorización y débito. La suite completa volvió a terminar con código 0.
- El E2E pausa el consumidor real de Logística después de confirmar el commit del inbox y antes del ACK (hook restringido a `NODE_ENV=test`), mata el proceso Nest, observa que RabbitMQ reencola el mensaje con `redelivered=true`, y reinicia Logística. La inbox evita duplicar plan/entrega y el checkout mantiene un solo pago/débito; la suite completa terminó con código 0.
- El E2E pausa el publicador de Pedidos, crea un checkout cuyo `order.created` queda durable en outbox, reinicia el servicio con el publicador habilitado y espera confirmación. Verifica una reserva consumida, un solo pago autorizado y un solo débito TerraWallet. Build de Pedidos y E2E local terminaron con código 0.
- Otro escenario detiene Inventario para dejar `order.created` en su cola durable, reinicia el contenedor local de RabbitMQ y verifica que el mensaje sobrevive y, al reconectar Inventario, causa un único consumo de stock, pago y débito. El E2E completo terminó con código 0; no usa broker externo.
- Las pruebas siguen usando identidades/cabeceras simuladas y no sustituyen validación de login, CI alojada ni pruebas móviles en dispositivo. No se accedió a producción ni se aplicaron migraciones remotas.

### Observabilidad local aislada — 2026-10-18

- Se añadió al override `docker-compose.local.yml` una pila Prometheus 3.13.3 + Blackbox Exporter 0.28.0 + Grafana 12.4.11, con retención local de 7 días, dashboard aprovisionado y alertas de indisponibilidad/latencia de readiness. No se incorporó al Compose base.
- Prometheus sondea por la red privada Docker el Gateway y los nueve microservicios a intervalos de 15 segundos; Prometheus y Grafana se publican solo en loopback. El puerto del Blackbox Exporter no se publica.
- Verificación runtime local: los diez targets quedaron `up`, `probe_success` devolvió 1 para todos, Prometheus cargó las dos reglas y Grafana confirmó la fuente de datos y dashboard provisionados. La primera pasada encontró rutas incorrectas en Logística/Notificaciones/Analítica; se corrigieron con el prefijo `/api/v1` y se verificaron de nuevo.
- Sigue pendiente instrumentación interna de negocio/CPU/memoria/colas, agregación centralizada de logs, envío de alertas y despliegue de observabilidad en Railway/staging. La pila local no prueba esos requisitos.

### Artefacto de carga k6 (sin ejecución contra un servicio)

- Se añadió `tests/load/marketplace.js` con el perfil k6 de 12 minutos descrito en Momento 1, etiquetas por catálogo/carrito/pedidos, límites de error/latencia, medición de confirmación de la saga, mínimo de 100 compras y guardarraíles que exigen `TARGET_ENV=staging`, confirmación explícita y URL de producción distinta.
- `grafana/k6:0.55.0` inspeccionó el script localmente con código 0; esta operación solo compiló configuración y sintaxis, no generó peticiones al Gateway.
- CI incluye inspección estática del script y pruebas que bloquean entorno no staging y URL idéntica a producción antes de ejecutar setup. Se documentó ejecución con fixtures sintéticos. Aún no hay resultado de carga ni métricas de recursos; la ejecución debe ocurrir únicamente en staging con cuentas y stock preparados.

## Endurecimiento del guardarraÃ­l de carga k6 en staging â€” 2026-10-18

- `tests/load/marketplace.js` ya no compara URLs como texto ni depende de `URL`, que no existe en el runtime k6 0.55 usado por CI. Normaliza esquemas HTTPS, host en minÃºsculas, punto DNS final y puertos por defecto; rechaza rutas, query, fragmento, credenciales y el mismo origen.
- La CI rechaza staging cuando coincide con producciÃ³n aun con diferencias de mayÃºsculas y puerto `:0443`; tambiÃ©n conserva el rechazo de `TARGET_ENV=production` y URL de producciÃ³n idÃ©ntica.
- VerificaciÃ³n local: `k6 inspect` pasa; destino production rechazado; origen igual normalizado rechazado; dos orÃ­genes HTTPS distintos pasan validaciÃ³n y la ejecuciÃ³n se detiene en la validaciÃ³n de las 200 cuentas ausentes, antes de cualquier solicitud. Workflow YAML parseado y `git diff --check` aprobado. No se hizo carga ni se contactÃ³ ningÃºn host externo.
- El workflow incluye tambiÃ©n regresiÃ³n para rechazar `BASE_URL` con ruta y para confirmar que dos orÃ­genes HTTPS distintos superan solo el guardarraÃ­l y se detienen por fixture incompleta, sin producir solicitudes.

## Orden de cierre propuesto

1. Confirmar con el profesor qué microservicios y formato de repositorios califican.
2. Agregar README por servicio y validar las plantillas de entorno contra la configuración real.
3. Ampliar las pruebas automatizadas: Identidad, Inventario, Pedidos y reglas de negocio de Pagos; definir estrategia para frontend. Pagos ya tiene pruebas locales del worker outbox.
4. Verificar migraciones y datos de demostración en bases de desarrollo.
5. Ejecutar pruebas de integración y flujos de compra/registro con evidencia reproducible.
6. Comprobar cada despliegue y preparar capturas/enlaces para la entrega.
7. Probar `driver-mobile` en dispositivos Android/iOS, validar almacenamiento y sincronización con red intermitente; cerrar Notificaciones y Analítica con E2E y snapshots.
8. Hecho localmente: ampliar el E2E a reembolso posterior al payout. Sigue pendiente recuperación después de reinicio con eventos/outbox financieros pendientes y validar el job E2E en CI; ya se cubren respuesta HTTP perdida/reintento idempotente, redrive seguro de DLQ, reinicio de Pedidos con `order.created` pendiente, reinicio del broker con mensaje durable, replay idempotente, DLQ acotada y entregas completas/parciales/fallidas. La comisión global del 10% fue aprobada.
9. Implementar CI/CD, seguridad, observabilidad, frontend y evidencias reproducibles;
   acordar con el equipo si se conserva Railway/SPA o se adapta la topología Render/Vercel.

## Evidencia que debe quedar para la entrega

- Matriz de requisitos y evidencia de aceptación.
- Repositorio(s), README(s), migraciones y `.env.example` sin secretos.
- Resultado fechado de compilación, unitarias y E2E.
- URLs de despliegue y respuesta de salud por microservicio.
- Evidencia de la comunicación REST/eventos y de los flujos de negocio.
- Integrantes y contribuciones respaldadas por el historial real de Git.

## Incremento verificado — 2026-10-18

- Analítica: build correcto y 7 pruebas unitarias; dos migraciones aplicadas sin pendientes sobre `analytics_db` en PostgreSQL temporal local. Fecha local se interpreta en la zona IANA solicitada (incluido DST), cohortes de merma acumulan la vida del lote, e ingresos se limitan al valor capturado distribuido contra líneas aceptadas.
- Pedidos: build correcto y 17 pruebas unitarias en 5 suites. Se añadió calificación única de comprador para órdenes parciales/entregadas con productos pagados; rating y evento `rating.created` se guardan en la misma transacción. Regresiones cubren liberación de reservas parciales, rechazo definitivo de TerraWallet, preservación ante 503 y recuperación de una autorización después de perder su respuesta.
- La migración completa de Pedidos y su tabla `order_ratings` se validó en una base distinta del PostgreSQL temporal; no se tocó ninguna base remota ni se hicieron despliegues.
- El frontend consulta y permite registrar la calificación desde los detalles de una compra completada; todos los archivos JavaScript del frontend pasaron `node --check`.
- Verificación transversal previa: Pedido build + 13/13 pruebas; Analítica build + 7/7 pruebas y `prisma validate`; `docker compose config --quiet` y `git diff --check` correctos. La pasada completa más reciente ejecutó las 187 pruebas unitarias backend; Gateway 2/2, móvil typecheck/6 pruebas/exportación Android y nueve builds también pasan. Compose solo se validó, no se desplegó.
- Cliente móvil: implementación Expo SDK 57; login conductor con SecureStore, rutas cacheadas/outbox ordenada SQLite, sincronización idempotente de despacho, llegada, cierre y temperatura; 6 pruebas de flujo aprobadas, typecheck, exportación Android y Expo Doctor 21/21 correctos. El Gateway permite renovar con refresh token sin access token vigente. No hay `adb`/emulador disponible en este entorno: falta probar en dispositivos y validar ciclo completo con servicios desplegados. `npm audit` reporta 29 hallazgos transitivos de herramientas Expo/Metro; las correcciones automáticas proponen downgrades mayores incompatibles, por lo que no se aplicaron a ciegas.
- Liquidación: se identificó el dato faltante en la ruta financiera; Logística no persistía `producer_id` por lote ni lo enviaba al cierre. Se añadió snapshot opcional con migración `20261018010000_delivery_lot_producer_snapshot`; build, 9/9 pruebas y las cinco migraciones se validaron en PostgreSQL 16 efímero. `charge_details` y `payouts` se añadieron después; ver el incremento de Pagos al final de este documento.

## Checkout recovery increment - 2026-10-18

- Frontend now persists the pending checkout attempt in `sessionStorage` (buyer, idempotency key, delivery address, line quantities and estimated prices). A timeout/transient error keeps the same key so reopening the cart retries the same operation instead of creating a second order or charge.
- If Order Service already persisted the order, the client finds it in the buyer-scoped history by idempotency key, then fetches its authorized detail to recover the persisted price/address snapshot. The order summary now counts pending orders, and the admin description includes pending purchases.
- Validation at that increment: `node --check` for `carrito.js`/`api.js`; frontend tests 2/2; Order Service build and 17/17 tests. The later cross-service E2E now exercises the asynchronous saga, including recovery of a durable `order.created` after restarting Pedidos; response-loss and broker-restart recovery remain open.

## Siguiente incremento

1. Hecho localmente: probar la saga asíncrona con migraciones en PostgreSQL efímero y RabbitMQ local, incluida recuperación de outbox después de reiniciar Pedidos y sus compensaciones.
2. Montar E2E reproducible con bases PostgreSQL aisladas por servicio y RabbitMQ local para compra→despacho→entrega parcial/total→captura/void→liquidación/reembolso; ya se prueba respuesta HTTP perdida, redelivery idempotente, DLQ/redrive, reinicio de Pedidos con un evento pendiente y reinicio del broker con un mensaje en cola. Falta validar su ejecución alojada en CI.
3. Hecho localmente: E2E Identity→Gateway usa PostgreSQL/RabbitMQ efímeros y llama por HTTP registro/verificación/login, sesión `/me`, refresh rotativo, rechazo del refresh anterior y logout/revocación; no necesita SMTP porque expone tokens de acción solo en este proceso de prueba. Probar `driver-mobile` en dispositivo Android/iOS con red intermitente/expiración y reset con SMTP real siguen pendientes. `rating.created` está cubierto de Pedidos a Analítica y Notificaciones por RabbitMQ.
4. Terminar seguridad/observabilidad, hacer instalación limpia con `npm ci`, validar CI alojada y preparar datos de demostración/evidencias de despliegue. Política aprobada: comisión global de 10%, congelada en cada línea de cobro (`PLATFORM_COMMISSION_RATE=0.10`).

## Incremento de Pagos — 2026-10-18

- Se añadieron `ChargeDetail`, `Refund`, `ProducerPayout`, `ProducerPayoutItem` y `SettlementAdjustment` al esquema Prisma del servicio de Pagos, con claves únicas y restricciones de montos.
- El evento `order.confirmed` de Pedidos crea el snapshot contable por línea y guarda nombre de producto y productor, cantidades, precio y tasa de comisión. Pedidos obtiene el nombre desde Catálogo y lo persiste mediante migración `20261018030000_producer_name_snapshot`. La tasa solo proviene de `PLATFORM_COMMISSION_RATE` en payment-service; la política aprobada es 10% global por línea, valor predeterminado `0.10`.
- En `order.fulfillment_closed`, Pagos compara cada línea con el snapshot confirmado, liquida únicamente cantidades/precios aceptados, devuelve a TerraWallet el saldo no aceptado y crea ítems/periodos mensuales UTC idempotentes con `payout.scheduled`; los ajustes negativos reducen el neto de liquidaciones abiertas del periodo.
- Se agregó `GET /api/v1/payments/payouts` para administración/productores y `PATCH /api/v1/payments/payouts/:id/complete` (solo admin, exige referencia de transferencia); el frontend incorpora la vista Liquidaciones para consultar importes y registrar transferencias efectivamente realizadas.
- Un reembolso previo a transferencia revierte la línea del payout pendiente; posterior a transferencia conserva el periodo cerrado y crea ajuste negativo en un periodo futuro. El comprador recibe el reembolso en TerraWallet dentro de la misma transacción.
- Verificación en ese incremento: Prisma validate/generate, Pedidos con 14/14 y Pagos con 17/17 pruebas unitarias; las cadenas de 10 migraciones de Pedidos y 5 de Pagos se aplicaron en PostgreSQL 16 efímeros locales. La pasada posterior elevó Pedidos a 16/16. No se tocó Neon ni producción.
- Pendiente: ejecutar E2E de compra→cierre→liquidación→reembolso con Postgres/RabbitMQ de desarrollo; agregar pruebas de controlador/permisos y conciliación/reintentos. La comisión global del 10% está aprobada y congelada en cada línea. El servicio no se desplegó ni la migración se aplicó en Railway/Neon.

## Incremento de recuperación de checkout — 2026-10-18

- Se corrigió un caso de fallo en la saga: al recibir un rechazo financiero definitivo del servicio de Pagos, Pedidos ahora cancela condicionalmente el intento pendiente, registra el evento `order.cancelled` en outbox y solicita liberar las reservas. Los errores transitorios conservan la operación para reintento idempotente.
- Ante timeout/5xx de Pagos, Pedidos consulta el pago por pedido con el JWT del comprador. Si el débito/autorización sí quedó persistido y su respuesta se perdió, continúa con la reserva existente y confirma la compra sin volver a debitar. Pagos valida ownership (o rol admin); prueba unitaria cubre los permisos.
- Validación: Pedidos build y 17/17 pruebas; Pagos build y 19/19; prueba de rechazo definitivo 409, error transitorio 503 y respuesta perdida con autorización persistida. Pasada completa de los nueve servicios: 187/187. Es recuperación síncrona y no completa la saga asíncrona exigida por el documento; E2E y conciliación aún pendientes.

## Verificación transversal — 2026-10-18

- Los nueve servicios compilaron con `npm run build`.
- Las pruebas de los nueve servicios pasaron con los argumentos que usa CI: Productores 39, Catálogo 79, Identidad 3, Inventario 9, Pedidos 14, Pagos 17, Logística 9, Notificaciones 5 y Analítica 7 (182 en total).
- Gateway/frontend: todos los módulos JavaScript pasaron `node --check` y `npm test` aprobó 2/2.
- `driver-mobile`: `npm run typecheck`, `npm test` (6/6) y `npx expo export --platform android --output-dir dist` terminaron con código 0.
- `git diff --check` pasó. No se ejecutó `npm ci` en cada carpeta ni el workflow alojado; tampoco se tocaron bases remotas, despliegues o producción.

## Incremento de saga durable de checkout — 2026-10-18

- Se añadió `POST /api/v1/orders/checkout/async`; el frontend inicia el pedido idempotentemente y conserva el estado pendiente mientras consulta la confirmación.
- Inventario atiende `order.created` marcado `checkout_mode=async_saga`, reserva cada línea con clave determinista ligada al pedido/línea y publica snapshots de lote/finca; tras `payment.checkout_authorized`, consume las reservas en una transacción atómica. Ignora `order.created` legado del checkout REST para no duplicar stock. Ante rechazo/cancelación libera las reservas activas.
- Pagos autoriza solo tras recibir todas las reservas, con idempotencia `checkout:<orderId>`; publica autorización/rechazo. Ante `order.cancelled`, anula autorización pendiente una sola vez.
- Pedidos registra estados de inventario/pago y solo confirma al recibir el consumo exitoso y pago autorizado; cancelaciones activan compensaciones. Se añadieron migraciones locales para esos estados/enlaces.
- Comisión: tasa global aprobada del 10%, congelada por línea en el snapshot contable (`PLATFORM_COMMISSION_RATE=0.10`).
- Validación local del incremento: Pagos build y 21/21 pruebas, Pedidos build y 18/18 pruebas, Inventario build y 11/11 pruebas; `prisma validate` pasó en los tres servicios. Todas las migraciones de los tres servicios se aplicaron en PostgreSQL 16 efímero. Dos recorridos runtime con RabbitMQ real y las tres bases aisladas confirmaron: pago autorizado de 400 COP, saldo 5.000→4.600, consumo de 4 kg, pedido confirmado y snapshot contable con 10%; ante saldo insuficiente, pedido cancelado, reserva liberada y ningún pago creado.
- La prueba runtime también detectó que `order-service` no arrancaba por el ámbito de inyección de `PrismaService` en `EventsModule`; se movió el worker de outbox al módulo de aplicación, se volvió a compilar y el servicio arrancó y procesó ambos flujos. La validación E2E fue local/semi-manual desde eventos y datos semilla; aún falta automatizarla y probar el endpoint HTTP con sesión real.
- Límite observado en Docker: Identidad e Inventario reinician por problemas de acceso a las bases Neon (Identidad informa cuota excedida; Inventario no alcanza su host DB). No se modificó ni se reintentó ninguna base remota. El E2E queda pendiente hasta disponer de PostgreSQL/RabbitMQ locales aislados o recuperar la base de desarrollo.

## Prueba HTTP automatizada de compra y entrega — 2026-10-18

- Se agregó `npm run test:e2e:checkout` (`scripts/checkout-saga-e2e.mjs`) y el job de CI compila ahora también Logística. Levanta cuatro PostgreSQL y RabbitMQ efímeros con nombres/puertos únicos, aplica migraciones, inicia Inventario/Pedidos/Pagos/Logística y llama por HTTP a `POST /api/v1/orders/checkout/async`; Catálogo queda como stub local.
- La ruta feliz creó pedido, debitó TerraWallet, consumió 4 kg, creó el plan, bloqueó la autorización antes de despachar, rechazó una anulación simultánea, completó paradas/entrega y verificó pedido `delivered`, pago capturado por 400 COP y payout al productor (40 COP de comisión al 10%, 360 COP netos). Saldo insuficiente cancela sin pago y libera stock; la carrera por la última unidad deja una sola reserva. Los cuatro escenarios pasaron localmente.
- La primera corrida reveló que `logistics-service` no arrancaba: `OutboxWorker` se registraba en `EventsModule`, fuera del alcance de `PrismaService`. Se movió al módulo raíz (igual patrón que el arreglo previo en Pedidos); el servicio arrancó y completó el E2E.
- El test genera una clave RSA efímera y JWT RS256 con issuer/audience de prueba para autenticar llamadas a los servicios; incluye regresiones de rechazo a cabeceras Gateway falsificadas. El flujo de login HTTP a través del Gateway se cubre por separado con `scripts/identity-gateway-e2e.mjs`. Docker debe estar activo. El checkout E2E usa URLs locales y limpia solo sus contenedores `ftt-checkout-e2e-*`; ningún E2E toca Neon/Railway. La ejecución alojada de CI sigue pendiente.
- El mismo E2E completa una transferencia con referencia y luego reembolsa el pago: verifica el abono único de 400 COP a TerraWallet, que la transferencia original no se modifica, que se crea en el siguiente periodo un ajuste de -360 COP (neto del productor después de la comisión congelada del 10%) y que reintentar no duplica el reembolso ni el abono.
- Se amplió el E2E con dos compradores haciendo checkout multilínea simultáneo: ambos pueden reservar la primera línea, pero solo uno obtiene la última unidad de la segunda. La prueba confirma pedido perdedor cancelado, reserva anterior liberada, ninguna transacción/débito para el perdedor y una sola compra/consumo efectivo. `node --check`, `git diff --check` y `npm run test:e2e:checkout` finalizaron con código 0 localmente.
- Se detectó y corrigió una condición de carrera de recuperación en Inventario: una redelivery podía recibir por idempotencia una reserva ya liberada y tratarla como disponible. El consumer ahora rechaza ese resultado como checkout fallido en lugar de publicar `inventory.order_reserved` con datos obsoletos; se añadió regresión unitaria. Inventario pasó 12/12 pruebas, build y el E2E integral con código 0.

## Mejora del envío SMTP de recuperación — 2026-10-18

- La solicitud de recuperación esperaba al transporte Gmail con los timeouts largos predeterminados de Nodemailer; eso podía exceder los 30 segundos del Gateway y mostrar “El microservicio no respondió a tiempo”. Se fijaron límites de conexión/saludo/socket (5/5/10 s por defecto, configurables con límites superiores) y se cierra el transporte tras el envío.
- La respuesta de recuperación sigue siendo neutra cuando el correo no puede enviarse; el servidor registra el fallo sin exponer si la cuenta existe. Pruebas cubren timeouts configurados, cierre del transporte y un SMTP local que no entrega el saludo; `identity-service` compila y aprueba 6/6 pruebas.
- La entrega efectiva de Gmail no se puede validar sin las variables SMTP correctas del entorno; no se cambiaron variables de Railway ni credenciales.

## Incremento de autorización de despacho — 2026-10-18

- Antes de sacar una ruta a tránsito, Logística ahora reserva cada autorización TerraWallet asociada desde Pagos y la liga al ID de la ruta. Si falta pago, no está autorizado, Payments no responde o la credencial interna no valida, la ruta no se despacha. Reintentar sobre la misma ruta es idempotente; la reserva impide una anulación concurrente. Las reservas ya adquiridas se liberan si falla el despacho y se confirma que la ruta continúa planificada; ante resultado ambiguo se conserva el bloqueo por seguridad.
- Pagos expone endpoints internos protegidos por `INTERNAL_API_KEY` y añade `fulfillmentRouteId`; migración `20261018030000_payment_fulfillment_lock`. Logística requiere `PAYMENT_SERVICE_URL` e `INTERNAL_API_KEY` compartida.
- Verificación local: Pagos build y 23/23 pruebas; Logística build y 11/11 pruebas. E2E completo de la ruta feliz aplicó migraciones y aprobó compra→despacho→entrega→captura→liquidación en infraestructura efímera. No se aplicó a Neon/Railway ni se modificó despliegue alguno.

## Incremento de destinatarios de Notificaciones — 2026-10-18

- Se integró un E2E que levanta el proceso real de Notificaciones y su consumidor RabbitMQ con PostgreSQL efímero; ejecuta migraciones y verifica eventos `delivery.scheduled` para comprador/conductor, `payout.scheduled` para productor, replay idempotente y tres eventos `notification.sent` en outbox.
- El E2E usa puertos y nombres únicos, un servidor HTTP stub solo para el contrato interno de Productores, y elimina exclusivamente los contenedores `ftt-notifications-*` que él creó. No utiliza Neon/Railway ni credenciales externas.
- Verificación local: `node --check scripts/notifications-e2e.mjs`, build de `notification-service`, E2E completo, 7 unitarias de Notificaciones; Productores 40/40, Logística 11/11, ambos builds correctos y `docker compose config --quiet`.
- El workflow de GitHub Actions ahora tiene un job aislado para instalar, generar Prisma, compilar y ejecutar `npm run test:e2e:notifications`. SMTP/SMS y ejecución alojada de CI continúan pendientes.

## Incremento de seguridad JWT entre servicios — 2026-10-18

- Se encontró que los guards de los ocho servicios de negocio aceptaban `x-gateway-user-id` y `x-gateway-user-roles` como identidad sin firma. Una llamada directa podía falsificar `admin` si los servicios eran accesibles fuera del Gateway.
- Se eliminó ese bypass en Productores, Catálogo, Inventario, Pedidos, Pagos, Logística, Notificaciones y Analítica: ahora cada servicio obtiene sujeto/roles del JWT RS256 validado. El Gateway dejó de propagar las cabeceras de identidad; sigue validando la sesión con Identity antes de enrutar.
- `scripts/checkout-saga-e2e.mjs` ahora genera una clave RSA temporal, firma JWTs de prueba con issuer/audience correctos y prueba rechazo de rol falsificado, sujeto falsificado y solicitud sin Bearer. Los ocho servicios compilaron y `npm run test:e2e:checkout` pasó toda la saga, incluidos esos casos negativos.
- Compose se ajustó para que Gateway sea el único puerto publicado fuera de loopback; servicios, RabbitMQ y Redis siguen disponibles desde el host en `127.0.0.1` para desarrollo. `docker compose config --quiet` y una inspección de puertos resuelta con placeholders seguros confirmaron el binding. Pendiente de plataforma: validar red privada/no exposición directa en el entorno desplegado y revocación de sesiones en acceso directo. No se cambiaron variables, bases, Railway ni producción.

## Contrato de calificación hacia Analítica — 2026-10-18

- Se añadió `npm run test:e2e:rating-analytics` y se integró al job E2E de CI. Usa Postgres y RabbitMQ Docker efímeros, migra bases separadas, inicia Pedidos y Analítica reales y firma JWTs RS256 temporales.
- El recorrido HTTP verifica una calificación válida, replay idempotente, una única fila de outbox, publicación durable, inbox de Analítica y proyección `rating_facts`; también valida el promedio de satisfacción para admin y el rechazo de acceso a comprador.
- Verificación local: ambos servicios compilaron y pasaron 27 pruebas unitarias (Pedidos 18, Analítica 9); el E2E completo pasó. Los contenedores temporales se eliminaron. No se conectó ni modificó Neon/Railway.
- Notificaciones también quedó integrado: consume `rating.created`, crea un aviso in-app obligatorio para el comprador con calificación, y protege el guardado idempotente en inbox/outbox. El E2E de Notificaciones ahora publica la calificación junto con los eventos de entrega y liquidación, comprueba la bandeja y repite los eventos sin duplicados; espera explícitamente el binding RabbitMQ antes de publicar.
- Verificación adicional local: Notificaciones build y 8/8 unitarias; E2E de RabbitMQ/Postgres efímeros pasó. Pendiente: ejecutar CI alojada y probar el flujo de conductor en dispositivo.

## Autenticación integrada Identity–Gateway — 2026-10-18

- Se añadió `npm run test:e2e:identity-gateway` y un job aislado en GitHub Actions. Inicia Identity y el Gateway reales, con migraciones sobre PostgreSQL temporal, RabbitMQ, claves RSA y `AUTH_EXPOSE_ACTION_TOKENS=true` limitado al proceso E2E.
- Por HTTP del Gateway comprueba registro solo como comprador, activación por email, login, validación de `/me`, rotación de refresh, rechazo del token rotado, logout autenticado y revocación inmediata del access token. Confirma en PostgreSQL dos sesiones revocadas y un solo evento `identity.user_created`.
- La ejecución local pasó. Una observación importante: Identity sirve `/auth` y `/health` sin prefijo global; el gateway conserva esos upstream paths y el E2E valida el contrato efectivo. No se modificaron URLs productivas ni Neon/Railway.

## Caché Redis de Catálogo — 2026-10-18

- Se añadió `catalog-service/test/cache-redis-e2e.cjs` y `npm run test:e2e:redis-cache`; el job `catalog-redis-cache-e2e` de CI usa Redis 7 aislado y también valida el modo sin conexión.
- Contra Redis real se verificó TTL predeterminado de 30 s, expiración efectiva, invalidación de ficha/precio/listado disponible y que no haya error de aplicación si Redis no está disponible.
- Verificación local: Catálogo build y 80/80 pruebas unitarias; ambos modos del E2E de Redis pasaron usando un contenedor temporal eliminado al terminar. Pagos compiló y aprobó 23/23; la comisión global del 10% ya se congela en cada detalle y se aplica al liquidar.
- Sin cambios en Neon/Railway ni en servicios locales preexistentes. Pendiente: observar los nuevos jobs en GitHub Actions y validar el resto de requisitos/dispositivos del PDF.

## Seguridad del proxy de respuestas — 2026-10-18

- Se eliminó el replay de respuestas exitosas mantenido en un `Map` del Gateway, cuya clave no incluía identidad ni tenía TTL: dos usuarios con la misma clave de idempotencia podían recibir el mismo cuerpo, además de permitir crecimiento de memoria no acotado.
- El Gateway conserva y reenvía `Idempotency-Key` al servicio destino; la deduplicación queda en los microservicios y sus restricciones persistentes. Prueba HTTP con Gateway/Identity/Catálogo stub verifica que dos usuarios con una misma clave reciben respuestas de su propia solicitud y que no se reenvían cabeceras de identidad falsificables.
- Verificación local inicial: suite Gateway 3/3 y `node --check frontend/server.mjs` pasaron. Pendiente en ese incremento: rate limit, revisión CORS/secretos y observación del comportamiento alojado.

## Rate limit del Gateway — 2026-10-18

- El mapa de ventanas local tiene un máximo de 10.000 clientes, poda entradas vencidas periódicamente y nunca agrega cada intento bloqueado. Cuando `REDIS_URL` está configurado, Redis aplica atómicamente la ventana deslizante compartida entre réplicas; las claves almacenan SHA-256 de la IP y vencen con TTL.
- `GATEWAY_TRUST_PROXY` configura saltos/subredes explícitos y por defecto permanece desactivado. Se rechaza confiar en `true` globalmente, que permitiría falsificar IPs con `X-Forwarded-For`. Compose conserva el modo seguro directo (`0`); detrás de proxy se debe declarar solo la cadena real de confianza.
- La prueba HTTP valida umbral, `Retry-After` e IP detrás de proxy; 8 unitarias cubren poda local, claves opacas Redis y manejo de errores. La integración contra Redis 7 real probó dos instancias independientes, bloqueo compartido y expiración de ventana. Si Redis falla, Gateway usa el limitador local acotado y emite aviso de degradación; Compose espera Redis saludable y lo configura en Gateway. CI incorpora Redis efímero para repetir la integración.
- Pendiente: observar el job en CI alojada y confirmar la disponibilidad de Redis/`REDIS_URL` y la cadena de proxies en el hosting final. También quedan revisión CORS/secretos y observación de CI/despliegue.

## Solicitud de habilitación de productor — 2026-10-18

- Se implementó el flujo faltante: un comprador activo y verificado envía una solicitud; un administrador consulta la bandeja y la aprueba o rechaza con notas. El registro público sigue creando exclusivamente compradores.
- La aprobación actualiza la solicitud, concede el rol productor, incrementa versiones, revoca sesiones existentes y escribe `identity.roles_changed` en una transacción. Hay protección contra solicitudes pendientes duplicadas, revisión propia y decisiones concurrentes.
- Verificación tras corregir un import de compilación: Identity build correcto y 10/10 unitarias. `scripts/identity-gateway-e2e.mjs` pasó el flujo HTTP real sobre infraestructura efímera: duplicado, aprobación, rechazo, reenvío, evento de cambio de rol y revocación/preservación de sesiones. Frontend pasó 6/6 pruebas.
- Sin cambios a Railway/Neon. Quedan pendientes validar el flujo visual en navegador dentro del stack final y ejecutar la CI alojada.

## Visibilidad de pedidos por rol — 2026-10-18

- Se amplió `scripts/checkout-saga-e2e.mjs` para consultar una compra real por HTTP como comprador, productor y admin. Los tres obtienen dirección y snapshots de nombre de producto/productor; el productor solo recibe sus líneas, un productor ajeno no ve el pedido y otro comprador recibe 403 al pedir el detalle.
- El E2E completo de checkout/logística terminó con código 0 después de las nuevas aserciones; también pasaron respuesta perdida/reintento, compensación, carrera por última unidad, entregas completa/parcial/fallida, recuperación de outbox y recuperación tras reinicio de RabbitMQ.
- Rebuild del Compose local aislado y smoke de Gateway/frontend: nueve servicios healthy y smoke pasó registro/verificación/login, catálogo/pedidos/billetera y nueva solicitud de productor. El rebuild rotó claves JWT solo del stack local; no tocó infraestructura remota.

## Revalidación de gates — 2026-10-18

- Las nueve suites unitarias backend volvieron a pasar en el mismo esquema de comandos que CI: 211/211. Frontend Gateway pasó 6/6 pruebas y la sintaxis de todos los módulos JS.
- `driver-mobile` pasó typecheck y 6/6 pruebas; `npx expo export --platform android --output-dir dist`, ejecutado desde su directorio de trabajo como en CI, exportó el bundle Android. No es una prueba en dispositivo ni genera APK/AAB instalable.
- No se ejecutó `npm ci` en checkout limpio ni workflow alojado; no hubo push, despliegue o cambios a Railway/Neon.

## Compose local aislado — 2026-10-18

- Se añadió `docker-compose.local.yml` como override optativo: crea nueve PostgreSQL 16 independientes, sustituye todas las URLs DB por hosts internos locales y usa nombres, volúmenes y puertos aislados (`14000`, `13101`–`13109`, `15431`–`15439`, RabbitMQ `25672/25673`, Redis `16379`). El Compose base para Neon permanece intacto.
- Se añadió `scripts/local-migrate.ps1`, que establece explícitamente URLs `127.0.0.1` para cada DB y corre `prisma generate` + `prisma migrate deploy` servicio por servicio; el entorno se restaura aunque haya error. Ningún contenedor aplica migraciones automáticamente al iniciar.
- Se añadió `scripts/local-up.ps1`: usa `.env.example`, crea claves RSA efímeras para desarrollo y satisface variables requeridas de Compose sin leer ni modificar `.env`. Los placeholders de URL de base son reemplazados por el override antes del arranque.
- La primera compilación encontró que el Dockerfile del Gateway omitía `auth-access.mjs` y `rate-limiter.mjs`, módulos que `server.mjs` importa. Se corrigió el empaquetado; las diez imágenes (Gateway + nueve servicios) compilaron.
- Verificación runtime local: `prisma migrate deploy` terminó sin error en las nueve PostgreSQL aisladas. Los nueve microservicios quedaron listos según `GET /api/system/health` (todos HTTP 200, PostgreSQL y RabbitMQ `up`; Catálogo también reportó Redis `up`), el Gateway pasó su healthcheck y la interfaz respondió HTTP 200 en `http://localhost:14000`.
- No se tocaron Neon/Railway ni los contenedores del Compose original; no se borraron volúmenes. El E2E funcional integral pendiente se ejecutó posteriormente en esta misma pila local; ver el incremento siguiente.

## Flujo integral de marketplace en Compose persistente — 2026-10-18

- Se añadió `npm run test:e2e:full-marketplace-local`, una prueba HTTP contra el Gateway y servicios reales del Compose persistente. Rechaza destinos fuera de loopback y comprueba que PostgreSQL Identity sea exactamente el contenedor local esperado (`127.0.0.1:15433`); la URL DB es local fija y no lee `.env`.
- El recorrido registra/verifica cuentas de prueba, promueve una cuenta únicamente como fixture admin local, aprueba una solicitud de productor, crea perfil/finca/categoría/producto/cosecha, publica la cosecha y espera el evento RabbitMQ que crea stock en Inventario. Luego recarga TerraWallet y compra por checkout REST.
- Aserciones: pedido confirmado con nombre real del producto/productor y dirección; consulta del pedido/detalle como comprador, productor y admin; pago visible para admin; saldo debitado exactamente por el precio y stock reducido de 25 a 23 kg.
- Resultado: PASS, pedido `3239c3d0-aa36-4d91-9023-b76380c08cd3`, total 2.000 COP. El comando dejó cuentas y recursos E2E identificables en los volúmenes locales persistentes. No se alteraron datos remotos ni el Compose original.
- Se añadió el job `full-marketplace-local-e2e` a GitHub Actions: en runner Ubuntu efímero arranca Compose con secretos JWT generados localmente, migra las nueve PostgreSQL, ejecuta el recorrido y elimina sus volúmenes aun si falla. Compose limita a dos las tareas simultáneas de build; `local-migrate.ps1` detecta Prisma tanto en Windows como en Linux.
- Verificación local de configuración: Docker Compose resolvió el overlay con `--parallel 2`, Node validó la sintaxis del E2E, `js-yaml` parseó el workflow y `git diff --check` pasó. La ejecución alojada del workflow sigue pendiente de push/PR; no hubo push.
- Pendiente para terminar el proyecto: CI alojada, ejecución de carga real en staging, prueba física/offline de la app móvil, proveedores SMTP/SMS reales, observabilidad integral y cierre de brechas documentales/plataforma frente al PDF.

## Verificación de cierre local y estado de despliegue — 2026-10-18

- En esta pasada, las nueve suites backend aprobaron **211/211** unitarias; Gateway **8/8**; `driver-mobile` pasó typecheck, **6/6** pruebas y exportación Android. Pasaron además checkout/logística, reconstrucción de Analítica, Notificaciones, rating→Analítica e Identity→Gateway en E2E locales aislados.
- El rate limit de Redis se probó contra Redis 7 real con dos instancias independientes, bloqueo compartido y vencimiento de ventana. El job de Gateway en CI ahora declara Redis efímero y ejecuta esta integración; el workflow se parseó localmente, pero no se ha observado en GitHub Actions.
- Se añadió `/health/ready` propio del Gateway; su Docker healthcheck ya no depende de que todos los microservicios estén arriba. El endpoint agregado `/api/system/health` sigue mostrando el estado de cada servicio para diagnóstico. Build de la imagen del Gateway y `docker compose config --quiet` pasaron.
- Consulta GET de solo lectura a producción el 18-10-2026: el agregador respondió HTTP 200, pero Identity reportó PostgreSQL `down` y HTTP 503, e Inventario agotó el timeout; Productores, Catálogo, Pedidos y Pagos reportaron ready. Revalidación el 18-10-2026 05:03 hora Colombia: misma condición exacta. **Producción no queda certificada ni se modificó.**
- No hay SMTP/URL de staging configurados en el `.env` local; no se envió correo ni se generó carga. No hay `adb`/emulador ni `act` disponibles. Siguen pendientes: CI alojada (requiere push/PR), recuperación con SMTP real, ejecución k6 solo en staging autorizado, prueba móvil física/offline, observabilidad Prometheus/Grafana operativa, decisión SPA/Next.js y monorepo/repos separados, y corrección/verificación de la disponibilidad remota de Identity e Inventario.

## Documentación operativa por servicio — 2026-10-18

- Se añadieron READMEs operativos para `identity-service`, `producer-service`, `catalog-service`, `inventory-service`, `order-service` y `payment-service`, que carecían de guía propia. Las rutas se cotejaron con los controladores y los comandos de prueba con los `package.json` actuales.
- Esto cierra la ausencia de documentación inicial de esos seis servicios, pero no sustituye pruebas remotas ni credenciales: CI alojada, staging, SMTP/SMS, observabilidad y dispositivos continúan pendientes según el estado de despliegue anterior.

## Corrección del gate k6 en CI — 2026-10-18

- Se corrigió `tests/load/marketplace.js`: los guardarraíles del destino se ejecutan al comienzo de `setup()`, antes de procesar fixtures o enviar HTTP. Esto permite que `k6 inspect` analice opciones sin credenciales y conserva el bloqueo previo a cualquier solicitud.
- Se corrigió `.github/workflows/ci.yml` para que `inspect` no intente pasar `-e` como argumentos de Docker después de la imagen.
- Verificación local con k6 0.55.0: inspección del script aprobada; `TARGET_ENV=production` y staging con URLs iguales se rechazaron; configuración staging válida pasó los guardarraíles y se detuvo por fixture ausente, sin producir carga.
- `docker compose ... config --quiet` y `git diff --check` pasaron. No se inició carga ni se tocaron servicios remotos.
- Pendiente: observar el workflow en GitHub Actions; ejecutar carga solo con URL/fixture de staging sintético; SMTP real, prueba móvil física y despliegue remoto siguen dependiendo de recursos externos. Producción continúa sin cambios.

## Revalidación runtime de observabilidad y workflow — 2026-10-18

- La pila local persistente continúa levantada y aislada bajo el proyecto Compose `farmtotable-local`; no se reinició ni se eliminaron contenedores o volúmenes.
- Prometheus responde y tiene 12 objetivos activos `up`; la consulta `probe_success` devolvió 10 muestras de servicios, todas con valor 1. El API de reglas reporta 2 alertas cargadas.
- Grafana `/api/health` responde HTTP 200, autentica y lista un dashboard provisionado `FarmToTable · Disponibilidad`. Gateway `/health/ready` devuelve HTTP 200.
- Se parseó `.github/workflows/ci.yml` con el paquete `yaml` que ya existe en `driver-mobile/node_modules`: YAML válido, 9 jobs. `git diff --check` pasa para los archivos de esta corrección.
- Alcance: esto demuestra observabilidad de readiness y latencia por probes en desarrollo local, no métricas internas de negocio, agregación central de logs, alertas remotas ni disponibilidad de producción. El siguiente paso de despliegue requiere una rama publicada para CI y un entorno staging identificado; no se publicaron cambios ni se alteró producción.

## Revalidación E2E integral y suites — 2026-10-18

- Se repitió `npm run test:e2e:full-marketplace-local` contra Gateway y los nueve microservicios del Compose local persistente, protegido por checks loopback y DB Identity `127.0.0.1:15433`. Resultado PASS: pedido `9822dc29-c712-45ed-aef5-3c4384119210` confirmado por 2.000 COP; el E2E comprobó nombres de producto/productor, dirección, visibilidad comprador/admin/productor, débito exacto de billetera y consumo de inventario.
- Las nueve suites backend se ejecutaron nuevamente: **211/211** pruebas aprobadas (Productores 40, Catálogo 80, Identidad 10, Inventario 12, Pedidos 18, Pagos 23, Logística 11, Notificaciones 8, Analítica 9). Pagos compiló como parte de su script de test.
- Gateway/Frontend: **8/8** pruebas unitarias, una integración Redis 7 entre réplicas aprobada y todos los módulos JavaScript del navegador pasaron `node --check`.
- No se produjo carga k6, no se ejecutaron migraciones remotas, no se publicó código y no se modificó producción.
- Inspección de entrega: rama local `main`, origin en GitHub configurado; GitHub CLI y Railway CLI no están instalados. No se iniciará un push a `main` porque el repositorio puede tener despliegue automático y aún no se ha identificado/confirmado un destino staging separado.

## Gate de lint ampliado — 2026-10-18

- Inventario y Pedidos ahora incluyen ESLint 10 con configuración TypeScript compartida, comando `npm run lint` y pasos condicionales en el job matricial de CI. Pedidos también declara `@types/express`, actualiza TypeScript a 5.9 y alinea su `lib` con ES2022 para tipar requests y `Error.cause`.
- Se quitaron casts `any` del flujo de eventos de Pedidos; el evento REST legado serializa Decimals/fechas de forma JSON explícita. El controlador HTTP usa tipos de Express y normaliza cabeceras repetibles sin cambiar rutas ni contratos.
- Validación Orders posterior a los cambios, en orden CI: `prisma generate`, typecheck, lint, 18/18 pruebas y build aprobados. Inventario: `prisma generate`, typecheck, lint, 12/12 pruebas y build aprobados.
- El workflow de backend aplica lint a los nueve servicios. Pagos, Logística, Notificaciones y Analítica ya tienen ESLint en su manifiesto con la configuración compartida; se corrigieron usos `any` en sus controladores/validación y hallazgos de código no utilizado. Los nueve comandos `npm run lint` aprobaron.
- Typecheck y pruebas/build posteriores: Pagos 23/23, Logística 11/11, Notificaciones 8/8, Analítica 9/9; los cuatro builds terminaron correctamente. La advertencia audit restante (principalmente transitiva de Jest/Prisma) no se resolvió con `--force`.
- Sin push, migraciones remotas ni despliegue. La ejecución alojada, staging separado, prueba física móvil, proveedores SMTP/SMS y disponibilidad remota de servicios siguen pendientes; no se certifica producción.

## Gate de tipos para los nueve backends — 2026-10-18

- La guía exige typecheck separado de build. Se comprobó `tsc --noEmit` en los nueve servicios y apareció un mock E2E de Catálogo que no satisfacía los contratos actuales de validación de productor/finca; se completó con `user_id` y los campos de snapshot de finca.
- Se añadieron scripts `typecheck` en los nueve `package.json` de backend y se añadió el paso al job matricial de backend en GitHub Actions (también al job de integración Redis del Catálogo). `npm run typecheck` aprobó en los nueve servicios.
- Actualización 2026-10-18: los nueve backends tienen ESLint 10/TypeScript ESLint con configuración compartida y gate `lint` en CI. En Productores se tiparon los mocks JWT, y se mantuvo la consulta de existencia en la aprobación documental. Productores pasa desde `npm ci` limpio, generación Prisma, typecheck, lint, 40/40 pruebas y build. Catálogo pasa lint, typecheck, 80/80 pruebas y build. Identidad pasa typecheck, lint, 10/10 pruebas, build y E2E real Identity↔Gateway con PostgreSQL/RabbitMQ efímeros.
- Las auditorías iniciales tenían vulnerabilidades críticas/altas; `npm audit fix` sin `--force` eliminó las críticas compatibles. Identidad migró Nodemailer a 10.1.2 y Notificaciones a 10.1.3; este último cambio compila correctamente. Al mover Prisma CLI al runtime apareció un advisory alto en `deepmerge-ts`; los nueve lockfiles fijan la rama 8.0.2 por override compatible con Prisma 6.19.3. Validación actual: `npm audit --omit=dev` informa cero vulnerabilidades en los nueve servicios. Las instalaciones completas aún reportan alertas de dependencias de desarrollo (Jest/TypeScript y tooling); falta priorizarlas y resolver las que apliquen sin `--force`.
- El workflow YAML se parseó de nuevo con éxito; se comprobó que el job matricial tiene el paso `npm run typecheck`. `npm ci --dry-run --ignore-scripts` pasó en Inventario después de normalizar su manifiesto. No se ejecutó GitHub Actions porque requiere publicar el cambio; no se tocaron servicios remotos.

## Gate de runtime Docker para migraciones y usuario no privilegiado — 2026-10-18

- Auditoría de los nueve Dockerfiles detectó que Prisma CLI no estaba en `dependencies` aunque el procedimiento de despliegue requiere `prisma migrate deploy`; además, cinco imágenes no copiaban la carpeta de migraciones al runtime. Se movió Prisma CLI a dependencias de ejecución en los nueve servicios, se sincronizaron sus lockfiles y se copió `prisma/` a Order, Payment, Logistics, Notifications y Analytics.
- Las cinco imágenes que arrancaban como root ahora declaran `USER node`, igualando a las cuatro restantes. El README documenta `npm run prisma:deploy` como pre-deploy por servicio; el arranque no corre migraciones automáticamente. Notificaciones actualizó Nodemailer a 10.1.3, que incluye sus propios tipos; se retiró `@types/nodemailer` y la compilación pasó.
- Docker Compose reconstruyó las nueve imágenes. En cada imagen se verificó que `npm run prisma:deploy -- --help` funciona y que existe `/app/prisma/migrations`; `docker image inspect` confirmó usuario `node` en las nueve. Luego, desde cada imagen, `prisma migrate status` se conectó exclusivamente a su PostgreSQL loopback del Compose aislado: las nueve reportaron esquema al día. Esta consulta no aplicó migraciones; tampoco se conectó a Neon/Railway.
- La auditoría `npm audit --omit=dev` quedó en cero vulnerabilidades en los nueve servicios. Notificaciones actualizó Nodemailer a 10.1.3 y compiló; el override de Prisma fija `deepmerge-ts` 8.0.2.
- Se añadieron diez archivos Railway config-as-code: los nueve backends fijan Dockerfile, migración pre-deploy y readiness según sus rutas reales; Gateway fija Dockerfile y `/health/ready`. Los diez TOML parsean localmente y las nueve variables de esquema apuntan a `DIRECT_URL` para migraciones. Falta que Railway aplique estos archivos al configurar el root directory y la ruta absoluta del config en cada servicio de staging.
- El 2026-10-18 se ejecutó `npm run test:e2e:full-marketplace-local`: PASS; registró un pedido confirmado y verificó saldo, consumo de inventario y visibilidad con detalle/dirección para comprador, administración y productor. El fixture aleatorio persiste solo en Postgres local del Compose.
- Regresión repetida el 2026-10-18: suites unitarias de los nueve servicios backend PASS (211 pruebas), Gateway/frontend PASS (8), app del conductor PASS (6) y `driver-mobile` typecheck PASS. `git diff --check` no reporta errores de whitespace.
- El primer intento de build paralelo expiró descargando npm (`ETIMEDOUT`); la reconstrucción posterior concluyó con las nueve imágenes. `npm audit --omit=dev` quedó limpio; se mantienen pendientes las alertas de dependencias de desarrollo y no se aplicó `--force`.
- Railway CLI 5.70.0 quedó disponible por `npx @railway/cli`; `railway whoami` respondió `Unauthorized. Please login with railway login`. No hay sesión ni proyecto enlazado, así que staging todavía necesita autenticación, configuración de raíz/config path y `DIRECT_URL` aislada por servicio. No se hizo push ni despliegue remoto; producción permanece sin cambios.
- El 2026-10-18 se añadió `RAILWAY_STAGING_RUNBOOK.md`, con los diez roots/config paths, rutas de readiness contrastadas con el código, orden de despliegue y checklist de variables sin secretos. Parseo/validación cruzada de TOML y runbook pasó; `.env` no está rastreado ni hay archivos staged.
- Railway CLI 5.70 señala retirada de Config as Code. La conversión a IaC requiere proyecto enlazado: `railway config migrate --show --variables unmanaged` confirmó que no hay proyecto local asociado. Se documentó no ejecutar cutover/apply sin revisar el plan del environment staging.
