# Evolución operativa de FarmToTable

Fecha de revisión: 2 de noviembre de 2026. Alcance: diagnóstico del código local y comparación con MOMENTO 1.pdf; no es una certificación del estado actual de producción.

**Actualización de implementación:** el flujo operativo, la planificación OSRM y las pruebas locales ya están construidos. Consulta `IMPLEMENTACION_LOGISTICA.md` para el alcance verificado, límites y estado de despliegue. Los hallazgos siguientes conservan el diagnóstico previo a los cambios.

## Hallazgos verificados

| Área | Situación actual | Brecha |
| --- | --- | --- |
| Flota | Vehicle persiste placa única, capacidad, refrigeración y activo. Hay endpoints y formulario de registro. | La interfaz muestra vehículos concatenados en texto; faltan inventario visual, edición y estados operativos detallados. |
| Conductores | Driver guarda vínculo con usuario, contacto, licencia y activo. | Mejorar gestión y mostrar disponibilidad por intervalo, rutas y carga de trabajo. |
| Asignación | Route relaciona vehículo, conductor, zona y entregas. Se comprueban capacidad, refrigeración y solapamientos. | La propuesta de horarios se construye en el navegador; no usa tiempos calculados por carretera. |
| Ubicaciones | DeliveryLot conserva coordenadas de finca. Delivery y RouteStop conservan direcciones, pero no coordenadas del destino/parada. | Capturar y confirmar puntos de entrega; conservar su instantánea en logística. No interpretar texto ambiguo como coordenadas verificadas. |
| Recorridos | La interfaz coloca recogidas primero y entregas después. | No hay motor de rutas, geometría vial, kilómetros, duración ni comparación de alternativas. |
| Seguimiento | Existen despacho, llegada a paradas, confirmación del comprador, incidencias de entrega y temperatura. | No existe seguimiento GPS continuo ni estimación dinámica de llegada. No confundir un estado manual con una posición GPS. |
| Presentación | El módulo concentra formularios y rutas en una sola pantalla. | Dividir en una operación diaria con tabla, mapa, filtros, resumen e información contextual. |

Fuentes locales: frontend/public/js/views/logistica.js; logistics-service/src/logistics.service.ts; logistics-service/src/logistics.dto.ts; logistics-service/prisma/schema.prisma. Las copias independientes están en repositorios/logistics-service; las próximas modificaciones del backend deben realizarse allí, conforme a la separación ya publicada. El frontend sigue en frontend/.

## Lo que exige el documento

MOMENTO 1, páginas 16–19: gestión de transportistas, vehículos, rutas, paradas y entregas. Páginas 35–36: consolidación por zona y ventanas, tiempos de desplazamiento/carga/descarga, capacidad máxima por tramo, recogida antes de entrega, exclusión de recursos superpuestos y operación del transportista. Permite una heurística revisada por el administrador; no exige afirmar un óptimo matemático global. El mapa ayuda al conductor, pero el backend conserva la autoridad sobre las transiciones y cantidades.

## Etapa 1: flota y planificación con mapa

Objetivo: registrar vehículos reales, seleccionar pedidos y obtener una propuesta vial comprobable antes de asignar y despachar.

1. **Centro logístico:** pestañas Resumen, Flota, Conductores, Planificación y Rutas. Indicadores con datos reales; filtros y estados vacíos con acciones útiles. Tablas compactas y detalle lateral.
2. **Flota:** alta y edición de placa, tipo, marca/modelo, capacidad útil y refrigeración. Estado disponible, mantenimiento o fuera de servicio; ocupación calculada por horario y asignaciones. Mantener histórico sin borrar vehículos vinculados a rutas. SOAT, revisión y vencimientos se incorporarán como control documental; las reglas de bloqueo deberán acordarse expresamente.
3. **Conductores:** selección desde cuentas autorizadas, perfil operativo, disponibilidad y asociación a la ruta. Mostrar el conflicto concreto cuando un horario no esté disponible.
4. **Direcciones verificadas:** seleccionar en mapa fincas y destino del pedido; conservar coordenadas y dirección acordadas en las instantáneas logísticas. Los pedidos antiguos sin coordenadas requieren revisión, no puntos inventados.
5. **Cálculo vial en backend:** integrar un proveedor configurable. Obtener recorrido por carretera, kilómetros, duración y fecha del cálculo. Diferenciar motor de cálculo y componente visual del mapa. Conservar la propuesta asociada al itinerario y sus restricciones.
6. **Planificador:** seleccionar pedidos, conductor, vehículo y horario; estimar servicio en cada parada; validar ventanas, recogidas, carga por tramo y frío. Mostrar paradas numeradas, recorrido y ocupación. Proponer una secuencia factible, con revisión del administrador antes de guardar.
7. **Despacho:** revalidar disponibilidad y recursos al confirmar; el cálculo previo no reserva por sí solo el vehículo. Despachar únicamente una ruta válida y mantener las transiciones existentes de recepción y pago.

### Criterios de aceptación de la primera etapa

- Un administrador registra varios vehículos y estos persisten después de recargar o reiniciar el servicio.
- Una placa duplicada, un vehículo en mantenimiento, exceso de carga, incompatibilidad de frío o un conductor/vehículo ocupado generan un rechazo claro del servidor.
- El mapa representa carreteras y paradas verificadas; la interfaz muestra distancia y tiempo estimados con el proveedor y momento del cálculo.
- El sistema verifica la factibilidad temporal de la secuencia y la carga máxima por tramo. Una ruta inviable no se presenta como lista para despacho.
- Si el proveedor falla o no encuentra recorrido, se informa y se conserva el trabajo; no se sustituyen kilómetros por datos ficticios ni se habilita silenciosamente el despacho.
- Se prueba con una ruta de varias fincas y compradores, además de casos de horario imposible, exceso de capacidad, doble asignación y servicio externo no disponible.
- Los datos de demostración, si se usan en una presentación, llevan identificación explícita y no se registran como flota real sin datos del propietario.

### Decisión pendiente: proveedor de rutas

Definir cobertura necesaria, presupuesto, uso de tráfico y restricciones de vehículos antes de contratar o activar APIs. Una ruta rápida para automóvil no garantiza un recorrido permitido para un camión. La integración debe permitir reemplazar al proveedor y mantener las claves en el servidor; las claves públicas de visualización se restringen por dominio.

- Google Routes documenta cálculo con tráfico; la optimización de una flota completa es una capacidad separada que debe evaluarse.
- OSRM calcula recorridos entre coordenadas en un orden dado; asignar múltiples pedidos a vehículos y cumplir ventanas requiere lógica adicional. Un despliegue propio o proveedor contratado exige operación y recursos.
- No tratar servidores públicos de demostración como infraestructura garantizada de una empresa.

Referencias: https://developers.google.com/maps/documentation/routes/config_trade_offs · https://project-osrm.org/docs/v26.4.0/http

## Etapas siguientes

| Prioridad | Resultado | Comprobación |
| --- | --- | --- |
| 2. Operación del conductor | Vista móvil, próxima parada, navegación, recogida y llegada con historial; reintentos conservando operation_id. | Un conductor solo consulta y actualiza su ruta; los reintentos no duplican movimientos. |
| 3. Seguimiento del comprador | Línea de tiempo, horario previsto, cambios notificados y recepción completa/parcial con motivo. | El comprador ve únicamente sus pedidos; las cantidades aceptadas determinan el cobro una sola vez. |
| 4. Evidencias e incidencias | Registro de daños, ausencia, temperatura y comprobante de recepción; responsables e historial. | Evidencias privadas, asociadas al evento correcto y accesibles solo a los roles autorizados. |
| 5. GPS real | Ubicación transmitida por dispositivo autorizado, antigüedad de señal y última conexión. | Mostrar claramente cuándo no hay señal; evaluar consentimiento, acceso y retención antes de activarlo. |
| 6. Gestión empresarial | Puntualidad, utilización de flota, costos, incidencias, ventas y liquidaciones conciliadas. | Indicadores con periodo, fuente, zona horaria y cobertura; sin números decorativos. |
| 7. Experiencia general | Catálogo visual, checkout claro, paneles por rol, diseño consistente y accesibilidad móvil. | Validar flujos completos y permisos, no solo capturas de pantallas. |

## Ejecución propuesta

Construir primero la etapa 1 con migraciones compatibles y pruebas de reglas críticas, conservar las bases y contratos existentes y desplegar mediante los workflows de cada repositorio. Revisar esa etapa con el propietario antes de extender GPS y automatizaciones. Este documento organiza el trabajo; no afirma que las funciones pendientes ya estén implementadas.
