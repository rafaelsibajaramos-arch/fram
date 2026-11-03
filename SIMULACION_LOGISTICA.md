# Logística y recorridos simulados

## Asignación automática y direcciones

La pantalla principal permite seleccionar pedidos y pulsar **Organizar entregas automáticamente**. El productor confirma la dirección exacta donde el repartidor recogerá la mercancía; el origen del lote se conserva separado. El repartidor sale desde la base registrada del vehículo, recoge en el punto confirmado y sigue al comprador. OSRM verifica que el punto de despacho esté a menos de 500 m de una vía transitable; si el punto importado de una finca no coincide con una carretera, se debe corregir mediante **Confirmar salida**, nunca desplazarlo en silencio. El servidor propone vehículo, repartidor, horario y recorrido; comprueba disponibilidad, pago autorizado, carga y ventanas. Tras revisar el acceso del vehículo, **Asignar e iniciar simulación** confirma la propuesta e inicia el recorrido. La zona `AUTO` es una etiqueta interna, sin campo obligatorio para el productor. La opción manual permite elegir conductor y vehículo; usa la base registrada y la zona automática sin exigir coordenadas ni códigos de zona.

Administración registra la **ciudad y departamento base** de cada repartidor y vehículo. Además confirma por dirección el punto de alojamiento del vehículo. El sistema prioriza bases cercanas a la primera recogida, exige repartidor y vehículo de la misma ciudad base, y prueba combinaciones disponibles compatibles con el peso. No limita el destino a esa ciudad: puede calcular viajes a otros municipios y departamentos si las ventanas lo permiten. La cercanía se preordena por distancia geográfica en franjas de 1 km; OSRM verifica después la viabilidad por carretera, sin afirmar un óptimo global. Los perfiles antiguos sin base necesitan completarse antes de participar en asignación automática.

Comprador, productor y administración trabajan con direcciones, barrio/vereda, ciudad y referencias, sin introducir coordenadas. La búsqueda presenta varias coincidencias para confirmar; si una manzana o lote no está cartografiado se puede buscar el barrio y ajustar el marcador. Los complementos privados (apartamento, nombre de quien recibe, instrucciones) no se envían al buscador. El mapa conserva internamente la ubicación necesaria para calcular rutas.

Se conserva Nominatim/OpenStreetMap como proveedor configurable (`GEOCODING_URL`). Las búsquedas son manuales, sin autocompletado, con caché y cola limitada a una petición cada 1,1 segundos por gateway. El proveedor público solo admite uso moderado y una instancia del gateway; para escalar hay que configurar un proveedor dedicado y su limitador compartido. No se deben incluir datos personales en las consultas. [Política de uso de Nominatim](https://operations.osmfoundation.org/policies/nominatim/).

## Operación desde la web

1. Administración entra en **Logística → Conductores** y registra un **repartidor simulado**: nombre, teléfono, identificación, ciudad y departamento base, y minutos de preparación (15 por defecto). No necesita crearle una cuenta de acceso.
2. En **Flota** registra ciudad, departamento, dirección de alojamiento, placa, tipo, marca, modelo, capacidad máxima y carga mínima operativa. Puede habilitar, deshabilitar o marcar mantenimiento.
3. El productor entra en **Logística → Asignar entregas**, selecciona una o varias ventas y pulsa **Organizar entregas automáticamente**. El sistema propone conductor, vehículo, salida desde su base, zona y horario. Los ajustes detallados de recogida, origen, zona y recursos siguen disponibles en **Opciones avanzadas de planificación**.
4. Se consideran cercanía a la recogida, ciudad base, peso, mínimo operativo, refrigeración y reservas. La propuesta vial confirma la viabilidad con OSRM antes de guardar. Se revisan las restricciones de acceso del vehículo: OSRM no garantiza restricciones para camiones ni tráfico en vivo.
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
