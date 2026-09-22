import { api, sesion } from '../api.js';
import { avisarError, aviso, boton, campo, el, entrada, pie, tarjeta, valores } from '../ui.js';

/** Vista heredada de registro: se conserva alineada con el registro publico. */
export function vistaRegistro(raiz) {
  raiz.append(el('h1', {}, 'Crear cuenta'), el('p', { class: 'subtitulo' }, 'El registro público crea una cuenta de comprador. El perfil productor es asignado por administración.'));
  const form = el('div', { class: 'campos' },
    campo('Nombre completo', entrada('full_name', { placeholder: 'Nombre y apellido' })),
    campo('Correo electrónico', entrada('email', { type: 'email', placeholder: 'correo@ejemplo.com' })),
    campo('Contraseña', entrada('password', { type: 'password', minlength: '10', placeholder: 'Mínimo 10 caracteres' })),
  );
  const submit = boton('Crear cuenta', async () => {
    const data = valores(form); if (!data.full_name || !data.email || !data.password) return;
    submit.disabled = true;
    try {
      await api.registrar({ full_name: data.full_name, email: data.email, password: data.password });
      const access = await api.autenticar(data.email, data.password);
      sesion.guardar(access); aviso('Cuenta creada', 'Su sesión se inició correctamente'); location.hash = '#/productos';
    } catch (error) { avisarError(error, 'No se pudo crear la cuenta'); } finally { submit.disabled = false; }
  });
  raiz.append(tarjeta('Datos de acceso', el('div', {}, form, pie(submit)), { pista: 'Los perfiles productor y administrador son asignados internamente.' }));
}
