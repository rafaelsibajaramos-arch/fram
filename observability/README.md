# Observabilidad local de FarmToTable

El Compose local aislado incluye Prometheus, Blackbox Exporter y Grafana para observar **disponibilidad HTTP y latencia de readiness** del Gateway y los nueve microservicios. Prometheus evalúa alertas de servicio caído y readiness lenta; Grafana carga automáticamente la fuente y el dashboard `FarmToTable · Disponibilidad`.

## Inicio

Desde la raíz, ejecuta `./scripts/local-up.ps1`. La configuración se agrega solo desde `docker-compose.local.yml`; no cambia el Compose base de despliegue ni requiere que los servicios implementen endpoints de métricas propios.

- Grafana: `http://127.0.0.1:13000` (usuario `admin`, contraseña local de desarrollo `farmtotable_local_only`).
- Prometheus: `http://127.0.0.1:19090`.
- El puerto del Blackbox Exporter no se publica al host; Prometheus lo consulta por la red interna de Docker.

Los puertos de host están enlazados exclusivamente a loopback. No publiques el override, Grafana ni Prometheus como endpoints públicos: la contraseña incluida es fija y solo para esta pila local. En un despliegue real se requieren credenciales administradas, red privada, almacenamiento/retención adecuados y alertmanager/canales de notificación.

## Alcance y comprobación

Las métricas `probe_success` y `probe_duration_seconds` demuestran respuesta HTTP 200 de `/health/ready` y tiempo observado desde Prometheus. No son métricas internas de negocio, CPU, memoria, base de datos o RabbitMQ, ni sustituyen el sistema de logs correlacionados. Esas piezas y alertas entregadas externamente deben instalarse y validarse en la plataforma de staging/producción.

Después de esperar dos intervalos de scrape, revisa `http://127.0.0.1:19090/targets` y el dashboard de Grafana. No se genera tráfico de carga: son sondeos de disponibilidad de baja frecuencia contra servicios locales.
