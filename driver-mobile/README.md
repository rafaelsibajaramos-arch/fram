# FarmToTable Conductor (React Native)

Cliente Expo para conductores. Usa el API Gateway público y el mismo login de Identidad; no se conecta directamente a puertos de microservicios.

## Desarrollo

1. Copia `.env.example` a `.env.local`.
2. Define `EXPO_PUBLIC_API_URL` como la URL del Gateway. Android Emulator: `http://10.0.2.2:4000`; iOS Simulator: `http://localhost:4000`; teléfono físico: `http://IP_DEL_COMPUTADOR:4000` en la misma red. Usa HTTPS fuera del desarrollo local.
3. Ejecuta `npm ci`, `npm start` y abre con Expo Go o un development build. Para exportar el bundle Android: `npm run build:android`.

La autenticación se completa contra `/api/v1/identity/auth/login` y `/auth/me`; el cliente exige el rol `driver`. Access/refresh tokens se almacenan en `expo-secure-store`; al recibir 401 intenta la rotación anónima del refresh token. El Gateway permite `/auth/refresh` sin access token, pero el refresh token sigue siendo obligatorio y está limitado por el rate limit general.

## Operación y modo sin conexión

- Obtiene únicamente las rutas asignadas al usuario autenticado mediante `GET /api/v1/routes`.
- Presenta secuencia de paradas, dirección, ventana, vehículo, peso, destino y estado.
- Permite despachar ruta, registrar llegada, cerrar entrega por kg aceptados y registrar temperatura de cadena de frío mediante las rutas existentes de Logística.
- Persiste una copia por usuario de las rutas y una outbox ordenada en SQLite. Cada mutación se guarda antes de intentar enviarse y lleva un UUID idempotente; al recuperar red se envía en orden y se refrescan las rutas.
- No marca una acción como completada hasta recibir confirmación del servidor. Errores 4xx bloquean la cola desde ese punto y muestran el motivo para no enviar operaciones posteriores fuera de orden.
- El cambio de cuenta no transmite acciones almacenadas para otra persona. Si se cierra sesión sin conexión, la revocación remota no se puede confirmar y la sesión del servidor caducará según su TTL.

## Verificación local

```bash
npm ci
npm run typecheck
npm test
npm run build:android
```

La exportación valida y empaqueta JavaScript para Android, pero no sustituye compilar/instalar un APK/AAB y probar cámara, almacenamiento, red y modo avión en dispositivos reales. Expo SDK 57 se eligió como plantilla de Expo Go durante la transición documentada hacia SDK 58; confirmar compatibilidad antes de actualizar el SDK.

La outbox y la caché local se guardan dentro del sandbox de la aplicación. No guardar datos en una ubicación compartida; probar la política de datos del dispositivo institucional antes de operación real, porque esta versión no habilita SQLCipher.
