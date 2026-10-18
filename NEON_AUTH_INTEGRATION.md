# Neon Auth e Identity

Identity usa `AUTH_PROVIDER=neon` y `NEON_AUTH_BASE_URL` (URL pública de la rama). Mantiene las claves RSA, issuer y audience actuales: los otros ocho servicios no cambian de proveedor JWT.

- Neon valida contraseñas y entrega los correos mediante su proveedor configurado. Identity conserva UUID, estado y roles locales; nunca importa roles del usuario remoto.
- Un login con credenciales antiguas válidas puede crear la cuenta Neon y vincularla. Solo una identidad remota verificada o la contraseña local comprobada permiten vincular una cuenta existente.
- La recuperación puede provisionar una cuenta Neon sin cambiar la contraseña antigua. Esta sigue funcionando hasta completar el cambio en Neon. Después del cambio se deshabilita definitivamente la contraseña local y se revocan las sesiones locales anteriores.
- Los nuevos registros crean compradores pendientes de verificación. El usuario recibe un código de correo y debe validarlo para entrar.
- Los enlaces de recuperación llegan a `/?recovery_context=…&token=…#/recuperar`. El cliente acepta parámetros antes o después del fragmento y retira los códigos de la barra de direcciones. El contexto local y el token Neon son de un solo uso.
- No se deben desactivar las variables Neon después de vincular cuentas: las contraseñas migradas ya no se validan localmente. Un rollback debe conservar el puente o planificar una recuperación explícita.

Migración aditiva: `20261019000000_neon_auth_identity_link` agrega `neon_auth_id` y `neon_credential_ready`. No modifica IDs ni relaciones comerciales.

El proveedor compartido de correo de Neon sirve para pruebas. Para producción se debe configurar un proveedor personalizado en Neon; el envío se realiza desde Neon y no utiliza los puertos SMTP de Railway. La aceptación de una solicitud por la API no demuestra recepción en la bandeja del destinatario.
