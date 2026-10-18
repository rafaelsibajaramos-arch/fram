# Operación de logística y recepción

## Flujo disponible en la web

1. El comprador crea un pedido con tarjeta simulada. Se reserva saldo y se confirma el inventario.
2. El evento `order.confirmed` crea el plan y sus entregas, conservando lotes, fincas, cantidades y precios de la compra.
3. Administración abre **Usuarios y roles**, asigna `driver` a la cuenta del transportista y, en **Logística y rutas**, registra su licencia y teléfono. También registra zonas y vehículos. `logistics_admin` permite coordinar rutas sin conceder administración general.
4. En **Planificar ruta**, el coordinador selecciona zona, transportista, vehículo, entregas y horarios. Debe revisar que las direcciones seleccionadas pertenezcan a la misma zona. La pantalla propone recogidas por finca antes de los destinos; no modifica las ventanas prometidas. El servidor valida disponibilidad de recursos, capacidad, refrigeración, horarios y secuencia.
5. El transportista entra a **Logística y rutas** con su cuenta. Solo ve sus rutas. **Iniciar ruta y despachar** exige autorización vigente de cada pago y bloquea su liberación mientras se opera la ruta. El pedido pasa a **En camino**.
6. Registra las llegadas en orden, primero recogidas y después destinos. Puede registrar temperatura. El comprador recibe avisos en su bandeja al despachar y al llegar.
7. Después de la llegada al destino, el comprador abre **Entregas** y confirma los kilos realmente recibidos de cada lote. Una recepción parcial o rechazada exige motivo. Ni el transportista ni el administrador pueden aprobar kilos en nombre de otro comprador.
8. Si no fue posible entregar, el transportista asignado puede registrar **entrega fallida**, con motivo y cero kilos aceptados. El fallo queda auditado en el evento de cierre, con el usuario que lo registró.
9. Solo al finalizar todas las entregas del plan se emite el cierre financiero: se cobra el importe aceptado, se libera el saldo reservado restante y se generan las liquidaciones por línea. La ruta finaliza cuando todas sus entregas son terminales. Estos cambios son asíncronos; actualiza la página para ver la confirmación financiera.

## Controles

- Propiedad validada en el servidor, también al repetir una operación.
- Confirmación bloqueada antes de registrar la llegada.
- Cantidades entre cero y lo despachado, precisión de tres decimales, todas las reservas y sin duplicados.
- UUID de operación y registro duradero para reintentos; reutilizarlo con otras cantidades se rechaza.
- Transacción serializable para recepción, cantidades, cierre del plan y outbox.
- Los estados del pedido ya no se editan manualmente para saltar checkout, despacho o recepción.
- Los eventos retrasados de despacho no hacen retroceder pedidos terminales.
- La app del conductor conserva su cola offline para llegadas, temperaturas y fallos; la recepción positiva corresponde al comprador en la web.

## Prueba reproducible y alcance

Levantar el stack aislado con `powershell -File scripts/local-up.ps1`, aplicar sus migraciones locales pendientes y ejecutar:

```powershell
npm run test:e2e:logistics-local
```

El script se niega a usar hosts remotos y verifica el contenedor PostgreSQL local antes de sembrar cuentas aleatorias. Prueba compras con tarjeta, planificación, despacho, llegadas, recepción completa/parcial/fallida, reintentos, estados, cobro y saldo liberado. No ejecutarlo contra producción.

La planificación es asistida y revisada por el coordinador: no es optimización geográfica automática ni seguimiento GPS en vivo. Las ventanas iniciales de pedidos existentes se calculan con `DELIVERY_WINDOW_START_DAYS` y `DELIVERY_WINDOW_END_DAYS` (por defecto 1 y 7). No se ha añadido selección de ventana/zona por el comprador en checkout. La confirmación independiente del comprador amplía el cierre que el PDF describe como registro del transportista de los kilos aceptados por el comprador. La generación y validación de un APK en un dispositivo físico sigue siendo una verificación separada; typecheck y pruebas no la sustituyen.
