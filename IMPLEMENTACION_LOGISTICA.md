# Centro logístico de FarmToTable

Implementado el 2 de noviembre de 2026. Código de negocio en los repositorios independientes; interfaz y herramientas de integración en este proyecto.

## Funciones construidas

- Centro logístico con Resumen, Flota, Conductores, Planificación y Rutas.
- Registro, edición y desactivación de flota; capacidad, refrigeración, marca/modelo, estado operativo, vencimientos y costo estimado por km.
- Perfiles de conductores, edición y asignación por horario. Rechazo de recursos superpuestos o no disponibles.
- Punto geográfico de entrega capturado en el carrito y conservado en Pedidos y Logística. Corrección autorizada del destino antes de asignar ruta.
- Motor OSRM con cartografía de Colombia. Matriz vial y propuesta factible con recogidas, entregas, servicio por parada, ventanas y carga por tramo. Mapa con recorrido y paradas numeradas.
- Confirmación con caducidad, revalidación transaccional e idempotencia; despacho y navegación hacia la próxima parada.
- Vista móvil del conductor, GPS voluntario, hora y precisión de última señal, registro y resolución de incidencias.
- Seguimiento privado del comprador, cantidades recibidas, comprobante imprimible/guardable como PDF y notificación de incidencias.
- Indicadores de operación y puntualidad con periodo y cobertura. Costos explícitamente estimados.
- Catálogo del comprador con tarjetas, búsqueda, filtro y agregado al carrito.

## Verificación realizada

- 33 pruebas de Logística, 24 de Pedidos, 9 de Notificaciones y 14 del gateway.
- TypeScript, ESLint y compilación de los tres backends modificados.
- Migraciones de Pedidos y Logística sobre PostgreSQL local. Prueba adicional de migración incremental con vehículo anterior conservado.
- Flujo HTTP con Nest, JWT de prueba, PostgreSQL y OSRM real: flota → destino → propuesta → asignación → despacho → GPS → incidencia → llegada → recepción. Se verifican accesos ajenos y reintentos sin duplicación.
- Navegador con creación/edición de vehículo, mapa de ruta y vista móvil del conductor, sin errores JavaScript. Los vehículos de esa prueba son datos locales identificados, no flota de producción.
- En la prueba integrada se utiliza un doble controlado de autorización de pagos y no se envían correos. Los eventos de recepción siguen conectados con el circuito de pagos existente.

Capturas locales: `.local-logistics/evidence/`. Resultado: `.local-logistics/result.json`.

## Operación de OSRM

Preparación local: `powershell -File scripts/osrm-local.ps1`. Descarga cartografía de Colombia y requiere varios GB de memoria durante su preparación. El servicio local se publica solo en `127.0.0.1:5500`.

Railway: servicio privado `routing-osrm`, puerto 5000 y comprobación `/health`. El propietario autorizó su creación y posibles cargos. Logística usa `OSRM_URL=http://routing-osrm.railway.internal:5000`. La construcción del motor y su salud se verifican antes de dar por finalizada la conexión.

## Límites explícitos

OSRM no aporta tráfico en vivo ni garantiza restricciones de camiones. El operador debe revisar accesos. La planificación devuelve una propuesta factible, no un óptimo matemático global. GPS funciona con permiso y la ventana abierta; no es telemetría autónoma en segundo plano. No se añadió una aplicación nativa ni almacenamiento de fotografías; la constancia de recepción es el registro autenticado de cantidades, nombre y observaciones. El pago continúa siendo el simulador acordado previamente.

## Puesta en producción

Desplegar Notificaciones, Pedidos y Logística desde sus propios workflows y después la interfaz/gateway. Las migraciones conservan los datos anteriores. Los pedidos antiguos sin coordenadas o zona requieren revisión del destino antes de planificar. Los vehículos reales deben registrarse con datos de la empresa; no se insertan matrículas ni conductores ficticios en producción.

Para una ruta anterior que todavía no fue despachada y carece de cálculo vial: cancelar su planificación desde Rutas, confirmar el destino y zona de sus entregas y calcular una propuesta nueva. No se modifican silenciosamente destinos ni horarios de rutas en tránsito.
