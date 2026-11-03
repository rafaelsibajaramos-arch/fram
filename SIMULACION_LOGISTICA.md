# Logística y recorridos simulados

## Operación desde la web

1. Administración entra en **Logística → Conductores** y registra un **repartidor simulado**: nombre, teléfono, identificación y minutos de preparación (15 por defecto). No necesita crearle una cuenta de acceso.
2. En **Flota** registra placa, tipo, marca, modelo, capacidad máxima y carga mínima operativa. Puede habilitar, deshabilitar o marcar mantenimiento. Las zonas de distribución también las administra este rol.
3. El productor entra en **Logística → Asignar entregas**. Confirma destino, zona, disponibilidad del producto y límite de recogida de sus ventas. Selecciona una o varias entregas, conductor, vehículo, origen y horario.
4. El sugeridor ordena vehículos compatibles por capacidad; considera peso, mínimo operativo, refrigeración y reservas. La propuesta vial confirma la viabilidad con OSRM antes de guardar. Se revisan las restricciones de acceso del vehículo: OSRM no garantiza restricciones para camiones ni tráfico en vivo.
5. En **Rutas y seguimiento → Abrir operación** se inicia la simulación. Se puede pausar, reanudar y cambiar la velocidad (1–120×). Preparación, esperas planificadas y atención en las paradas pertenecen al reloj simulado; la velocidad permite una demostración corta.
6. Comprador y productor ven el recorrido en **Entregas**, con conductor, vehículo, preparación/recogida/trayecto/llegada, progreso y tiempo estimado. El marcador se actualiza cada tres segundos, con procesamiento del servidor cada dos segundos.
7. Al llegar, el comprador puede confirmar cantidades completas, parciales o rechazadas. Si no interviene, la simulación confirma la entrega completa después de **45 segundos reales** por defecto. Se identifica expresamente como cierre simulado. El comprador conserva un botón para registrar su confirmación personal posterior y un comprobante imprimible.

## Varias entregas por conductor

Una ruta puede incluir varias recogidas y entregas. Se comprueban carga por tramo, recogida antes de entrega, tiempos de carga/descarga, margen de preparación, ventanas y desvíos. Se rechaza un trayecto agrupado que exceda el viaje directo en más de un factor de 1,8 más 20 minutos y el servicio de parada. El mínimo de carga se compara con la carga máxima realmente transportada en la ruta.

Las nuevas entregas se agrupan **al planificar, antes de despachar**. Para modificar una ruta planificada se cancela y se calcula otra propuesta. No se insertan paradas arbitrarias en un recorrido ya iniciado. Se permite otra ruta posterior si no se superpone; una ruta atrasada aún en curso bloquea nuevas asignaciones del mismo conductor o vehículo.

## Acceso, pagos y persistencia

- Solo administración registra personas y vehículos. El productor asigna recursos habilitados únicamente a entregas cuyos productos le pertenecen; los envíos históricos que mezclan productores los coordina administración.
- El comprador solo consulta sus envíos y confirma su recepción. El seguimiento compartido no expone direcciones de otros compradores de la misma ruta.
- El despacho verifica una autorización **Wompi Sandbox aprobada**. La simulación no inventa pagos ni saldos. Un pedido puede mantener varios bloqueos de rutas, uno por envío, sin liberar los demás al cancelar una ruta.
- La recepción publica los eventos de cierre habituales. El reconocimiento personal posterior no repite la liquidación. Las diferencias de cantidades siguen el flujo de devoluciones Wompi existente.
- Reloj, posición, pausas y paradas se guardan en PostgreSQL. El proceso sigue sin tener abierta la página y recupera el progreso tras un reinicio. Los trabajadores usan leases y operaciones deterministas para evitar duplicar paradas/cierres.
- El GPS real y el recorrido simulado son modos separados. Los perfiles simulados quedan identificados en pantalla; estas posiciones no representan personas reales ni prueban una entrega física.

## Configuración y validación

Logistics utiliza `DATABASE_URL`, `DIRECT_URL`, `RABBITMQ_URL`, `JWT_PUBLIC_KEY`, `INTERNAL_API_KEY`, `PAYMENT_SERVICE_URL`, `PRODUCER_SERVICE_URL` y `OSRM_URL`. Se conservan las variables de autenticación y puerto existentes. Las nuevas tablas y columnas se instalan mediante migraciones incrementales; no se reinician datos.

La prueba `node scripts/simulation-integration.cjs` crea PostgreSQL desechable local, aplica migraciones, ejecuta Nest con JWT y validación estricta, utiliza OSRM local en `127.0.0.1:5500`, y prueba dos entregas con el mismo repartidor, permisos, preparación, mínimo de carga, ventanas, bloqueos reales del servicio de pagos y recepción manual/automática sin duplicar cierre. Los pagos son fixtures aprobados en la base aislada; no ejecuta transacciones con Wompi. Con `PLAYWRIGHT_MODULE_PATH` también verifica las pantallas de comprador, productor y registro administrativo en Edge.
