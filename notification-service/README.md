# Notification Service

Servicio NestJS con base PostgreSQL propia (`notification_db`). Consume eventos de identidad, pedidos, pagos, entregas, disponibilidad de producto y cadena de frío desde RabbitMQ. La compra nunca espera el envío de una notificación.

## API

- `GET /api/v1/notifications/me?limit=50`: bandeja del usuario autenticado.
- `GET /api/v1/notifications/user/:id`: bandeja propia; `admin` también puede consultar otro usuario.
- `PATCH /api/v1/notifications/:id/read`: marca como leída solo una notificación propia.
- `GET /api/v1/notification-preferences`: preferencias propias.
- `PUT /api/v1/notification-preferences` con `{ "notification_type": "delivery.scheduled", "channel": "email", "enabled": true }`.
- `GET /api/v1/health/ready`: verifica PostgreSQL y RabbitMQ.

Todas las rutas pasan por el Gateway público, que valida la sesión y propaga el usuario. El acceso interno a datos mínimos de contacto de Identidad usa `INTERNAL_API_KEY` dentro de la red privada; esa ruta no se registra en el Gateway.

## Entrega

La bandeja `in_app` se persiste inmediatamente. Los eventos con `producer_id` resuelven el `user_id` propietario mediante una ruta interna protegida de Productores; los eventos logísticos incluyen el `driver_user_id` derivado por Logística. Email usa SMTP y timeouts acotados; SMS llama un webhook configurado y envía un `Idempotency-Key` estable. Canales email/SMS son opcionales y se intentan hasta tres veces con espera creciente. El estado y cada resultado se guardan; la publicación de `notification.sent` / `notification.failed` usa outbox durable. SMTP requiere credenciales del servicio de correo. SMS requiere implementar/configurar un proveedor y aportar un teléfono en el evento; el modelo de Identidad actual no mantiene teléfonos verificados.

La unicidad `(source_event_id, user_id, channel, type)` evita filas y envíos duplicados cuando RabbitMQ redelivery el mismo hecho. El `Message-ID` de correo y la clave SMS permanecen estables entre reintentos. La entrega externa exactamente-una-vez depende de que el proveedor respete esa clave.

## Desarrollo local

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test
```

Configurar `DATABASE_URL` pooled, `DIRECT_URL` directo para migraciones, RabbitMQ, JWT público, `IDENTITY_SERVICE_URL`, `PRODUCER_SERVICE_URL`, `INTERNAL_API_KEY` compartida solo en servicios privados, y opcionalmente SMTP/SMS. La migración inicial de este servicio se probó solo en PostgreSQL efímero local; no se ejecutó en Neon ni producción.
