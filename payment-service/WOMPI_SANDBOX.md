# Pagos exclusivos por Wompi Colombia Sandbox

La aplicación ya no ofrece TerraWallet/TeraWallet, tarjetas generadas, recargas ni cargos ficticios. El comprador paga en el checkout alojado por Wompi. La aplicación no recibe números de tarjeta ni CVV. Se mantienen las integraciones de negocio con Inventario, Pedidos, Logística y Notificaciones.

## Configuración pendiente del comercio

En el `.env` local quedaron los nombres de las variables. Cargar las cuatro llaves desde el panel Sandbox de Wompi; no enviarlas por chat ni subirlas a GitHub. En Railway pertenecen solamente a `payment-service`:

```dotenv
WOMPI_PUBLIC_KEY=pub_test_...
WOMPI_PRIVATE_KEY=prv_test_...
WOMPI_INTEGRITY_SECRET=test_integrity_...
WOMPI_EVENTS_SECRET=test_events_...
WOMPI_REDIRECT_URL=https://fram-production.up.railway.app/#/pedidos
```

Configurar como URL de eventos del ambiente Sandbox:

`https://fram-production.up.railway.app/api/v1/payments/wompi/events`

La URL de retorno solo lleva al historial. Nunca confirma una compra. Las llaves de producción se rechazan deliberadamente. Sin las llaves el servicio sigue disponible para consultar historial, pero informa `paymentsReady=false` y el checkout devuelve un error de configuración, sin recurrir al simulador.

## Flujo

1. Pedidos valida precios y solicita reservas a Inventario mediante la saga existente.
2. La reserva consistente crea en Pagos una intención pendiente con referencia única, importe y vencimiento de diez minutos.
3. El comprador obtiene una URL del checkout Wompi con firma de integridad calculada exclusivamente en servidor.
4. El webhook valida ambiente y firma, consulta la transacción con la llave privada y coteja referencia, moneda e importe. Los reintentos no duplican la autorización.
5. Solo la aprobación verificada permite consumir inventario y confirmar el pedido. La confirmación genera las entregas existentes.
6. Los rechazos y vencimientos cancelan el intento y liberan las reservas. Una aprobación que llega después de cancelar solicita devolución y no habilita despacho.
7. Una recepción parcial crea un reembolso por el importe no aceptado. Un worker duradero lo solicita a Wompi Sandbox V2; únicamente una respuesta aprobada, con transacción e importe coincidentes, marca esa operación como `approved`.

El estado interno `authorized` conserva la compatibilidad de la puerta de despacho: significa que Wompi aprobó el cobro, no que se retuvo un saldo interno ni que se haya implementado preautorización bancaria. `capturedAmount` representa el importe aceptado al cerrar la entrega. El estado real del proveedor se conserva por separado en `providerStatus` y las devoluciones en `refundOperations`.

## Operación y conciliación

Si un reembolso queda `unknown` o `submitting` después de un fallo de red o reinicio, no se reenvía automáticamente. Se debe conciliar su referencia en Wompi antes de cualquier nuevo intento; reenviar a ciegas podría duplicar la devolución. No existe botón que lo marque como exitoso sin confirmación del proveedor.

Las liquidaciones a productores continúan como registro contable. Se retiró la opción de marcar transferencias manuales como pagadas. El cobro al comprador no ejecuta una dispersión bancaria a productores: ese producto de Wompi requiere habilitación e integración independientes y no se presenta como implementado.

La migración conserva las tablas y columnas históricas del simulador sin exponer operaciones activas sobre ellas; identifica sus pagos como `legacy_simulator`. No convierte esos saldos en fondos del comercio. Los nuevos pagos usan `wompi`.

## Verificaciones

- Pruebas de firma, centavos, llaves Sandbox, propiedad del pedido, rechazo, aprobación tardía e idempotencia del webhook.
- Pruebas de saga de Pedidos, reservas de Inventario, Notificaciones y sesión del gateway.
- Migración incremental en PostgreSQL local, conservando un pago anterior.
- Aprobación, contabilidad de recepción parcial y reembolso persistente en PostgreSQL real con proveedor HTTP controlado.
- Carrito ejecutado en navegador: sin selector de tarjetas, conserva el intento y redirige exclusivamente a Wompi.

Estas pruebas no sustituyen una transacción contra la cuenta Wompi Sandbox del comercio. Esa prueba queda pendiente de las llaves y de configurar el webhook en el panel Wompi.

Documentación oficial consultada el 2 de noviembre de 2026:
- [Checkout e integridad](https://docs.wompi.co/docs/colombia/widget-checkout-web/).
- [Firma de eventos](https://docs.wompi.co/docs/colombia/eventos/).
- [Consulta de transacciones desde servidor](https://docs.wompi.co/docs/colombia/transacciones/).
- [Reembolsos V2 Sandbox](https://docs.wompi.co/docs/colombia/reembolsos-sandbox/).
