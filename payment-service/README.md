# payment-service

Servicio NestJS de pagos simulados con saldo común, generador de tarjetas virtuales, autorizaciones, captura, void, reembolsos y liquidaciones a productores. Puerto predeterminado: `3006`. No procesa datos reales de tarjetas; mantiene un libro contable en su PostgreSQL y publica eventos por RabbitMQ.

## Desarrollo

Configura `.env.example` para una base aislada y RabbitMQ:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

Usa `prisma migrate deploy` solo con una base de desarrollo autorizada. Para el Compose aislado, consulta [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon).

## Rutas principales

Las rutas usan prefijo global `/api/v1`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/payments/wallet/:buyerId` | Consultar billetera propia/admin |
| POST | `/api/v1/payments/wallet/:buyerId/top-up` | Cargar saldo simulado propio o por admin |
| GET/POST | `/api/v1/payments/cards/:buyerId` | Listar o generar una tarjeta ficticia Visa/Mastercard/AmEx |
| DELETE | `/api/v1/payments/cards/:buyerId/:cardId` | Eliminar una tarjeta sin afectar el saldo común |
| POST | `/api/v1/payments` | Crear pago |
| PATCH | `/api/v1/payments/:id/authorize`, `/capture`, `/void`, `/refund` | Ciclo de pago según rol/servicio interno |
| GET | `/api/v1/payments`, `/api/v1/payments/:id`, `/by-order/:orderId` | Consultas con aislamiento por comprador/admin |
| GET | `/api/v1/payments/payouts` | Liquidaciones propias de productor/admin |
| PATCH | `/api/v1/payments/payouts/:id/complete` | Registrar transferencia con referencia (admin) |
| GET | `/api/v1/health`, `/api/v1/health/ready` | Estado y readiness |

Las operaciones internas requieren `INTERNAL_API_KEY`; no la compartas con el navegador. La comisión de plataforma predeterminada acordada es global del 10% y se congela en los detalles de cobro.

## Pruebas

`npm test` compila y ejecuta pruebas unitarias. `npm run test:integration` requiere PostgreSQL/RabbitMQ locales efímeros para probar publicación y outbox; el E2E de checkout se lanza desde la raíz.
