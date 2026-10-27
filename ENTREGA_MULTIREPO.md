# Actividad: despliegue automatizado con GitHub Actions

El trabajo se administra desde `C:\Users\rafae\VsCode\fram-main`.
Las copias Git independientes están en `repositorios/`; cada carpeta tiene su propio `.git` y remoto. Esta carpeta se excluye del Git principal para evitar repositorios anidados como submódulos accidentales. El código original se conserva como referencia; los siguientes cambios de cada microservicio deben hacerse en su copia independiente.

| Carpeta dentro de repositorios | Repositorio GitHub |
| --- | --- |
| producer-service | https://github.com/rafaelsibajaramos-arch/producer-service |
| catalog-service | https://github.com/rafaelsibajaramos-arch/catalog-service |
| identity-service | https://github.com/rafaelsibajaramos-arch/identity-service |
| inventory-service | https://github.com/rafaelsibajaramos-arch/inventory-service |
| order-service | https://github.com/rafaelsibajaramos-arch/order-service |
| payment-service | https://github.com/rafaelsibajaramos-arch/payment-service |
| logistics-service | https://github.com/rafaelsibajaramos-arch/logistics-service |
| notification-service | https://github.com/rafaelsibajaramos-arch/notification-service |
| analytics-service | https://github.com/rafaelsibajaramos-arch/analytics-service |
| pipelines | https://github.com/rafaelsibajaramos-arch/pipelines |

## Requisitos de la actividad

- Cada microservicio tiene `.github/workflows/deploy.yml` y llama al workflow central mediante `workflow_call`.
- El flujo obliga a pasar pruebas antes de Docker y ambos antes del despliegue.
- Docker publica una imagen etiquetada con el SHA del commit. Railway reconstruye el mismo código probado con su Dockerfile.
- `RAILWAY_TOKEN` se guarda cifrado en GitHub Actions Secrets; las bases, JWT y correo permanecen en Railway.
- Existe una ejecución controlada que falla y bloquea Docker y despliegue, sin alterar código de negocio.
- Las capturas y reflexión están en `repositorios/pipelines`. Completar los nombres reales del equipo antes de entregar.
- No se utiliza staging. El frontend y las bases de datos existentes se conservan.

## Operación

Trabajar en `repositorios/<microservicio>`, ejecutar sus comprobaciones y hacer commit/push en ese repositorio. Los scripts de administración se encuentran en `scripts/*multirepo*.cjs` de este proyecto.

Una ejecución verde con deploy omitido no prueba despliegue. Consultar Actions de cada repositorio para verificar que el job de producción finalizó correctamente.

**Resultado verificado el 27 de octubre de 2026:** los nueve workflows completaron pruebas, Docker y despliegue. El gateway confirmó los nueve servicios con HTTP 200 y `listo: true`. Los enlaces y capturas están en `repositorios/pipelines/EVIDENCIAS.md` y publicados en el repositorio central. El PDF de reflexión tiene una página; falta completar los integrantes reales del equipo.

Durante la conexión se reconcilió la migración `20260921000000_certification_files` de Producer: el tipo, las ocho columnas y el índice ya existían y coincidían con el SQL. Se registró como aplicada con Prisma, sin recrear objetos ni borrar datos. Las rutas de salud se toman del archivo de cada servicio: algunos usan `/health/ready` y otros `/api/v1/health/ready`.
