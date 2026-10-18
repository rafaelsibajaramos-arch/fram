# producer-service

Microservicio NestJS para perfiles de productores, fincas, coordenadas de recogida y certificaciones. Puerto predeterminado: `3001`. Mantiene una base PostgreSQL propia y publica eventos de dominio mediante RabbitMQ.

## Desarrollo

Configura las variables del servicio (ver `.env.example`), genera Prisma y migra una base de desarrollo aislada:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

No uses `prisma migrate dev` contra una base compartida o productiva. La pila segura de desarrollo está documentada en [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon).

## Rutas principales

El servicio no configura prefijo global.

| Método | Ruta | Uso |
|---|---|---|
| GET/POST | `/producers` | Consultar y crear perfiles con autorización |
| GET/PATCH | `/producers/:id`, `/producers/by-user/:userId` | Consultar/editar perfil |
| POST/GET | `/producers/:producerId/farms` | Registrar y listar fincas |
| GET/PATCH | `/farms/:farmId` | Consultar/editar finca |
| PATCH | `/farms/:farmId/enable`, `/farms/:farmId/disable` | Cambiar disponibilidad |
| POST/GET | `/producers/:producerId/certifications` | Registrar y consultar certificaciones |
| GET | `/health`, `/health/ready` | Estado y dependencias |

La autorización se basa en JWT RS256 y roles; los endpoints internos requieren `INTERNAL_API_KEY`. No habilites `AUTH_DISABLED` fuera de pruebas locales aisladas.

## Verificación

`npm test -- --runInBand` ejecuta Jest; `npm run build` compila NestJS. `npm run test:e2e` requiere las dependencias indicadas por la configuración E2E del servicio.
