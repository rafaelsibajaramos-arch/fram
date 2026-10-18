# identity-service

Servicio NestJS de identidad: registro de compradores, autenticación JWT, sesiones, verificación de correo, recuperación de contraseña, roles y solicitudes de habilitación de productor. Puerto predeterminado: `3003`.

## Desarrollo y migraciones

Desde esta carpeta, instala dependencias (`npm ci`), configura las variables de `.env.example` y usa una base de desarrollo aislada. Después ejecuta:

```bash
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

`DATABASE_URL` es para runtime; `DIRECT_URL` se usa para migraciones. Para el stack aislado del monorepo, sigue [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon). Nunca apuntes `prisma:deploy` a producción sin aprobación y respaldo.

## Rutas principales

No hay prefijo global: las rutas comienzan en `/auth` y `/health`.

| Método | Ruta | Uso |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | Cuenta buyer y ciclo de sesión |
| POST | `/auth/email/verify`, `/auth/password/reset/request`, `/auth/password/reset/confirm` | Verificación y recuperación |
| GET | `/auth/me`, `/auth/sessions` | Usuario autenticado y sesiones |
| POST | `/auth/producer-applications` | Solicitud de habilitación de productor |
| GET/PATCH | `/auth/producer-applications`, `/auth/producer-applications/:id` | Revisión administrativa |
| GET/PATCH | `/auth/users`, `/auth/users/:id/roles`, `/auth/users/:id/disable` | Administración de usuarios (admin) |
| GET | `/health`, `/health/ready` | Liveness y readiness de PostgreSQL/RabbitMQ |

## Pruebas

`npm test` ejecuta Jest. Los flujos reales Identity→Gateway se prueban desde la raíz con `npm run test:e2e:identity-gateway`; requieren Docker y usan servicios/base de datos efímeros. El envío real de correo requiere SMTP configurado; no se valida con tokens expuestos fuera del proceso E2E aislado.
