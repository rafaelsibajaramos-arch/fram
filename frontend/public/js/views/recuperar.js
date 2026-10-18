import { api } from '../api.js';
import { el } from '../ui.js';

export function vistaRecuperar(raiz) {
  const linkedToken = new URLSearchParams(location.hash.split('?')[1] ?? '').get('token');
  if (linkedToken) history.replaceState(null, '', `${location.pathname}${location.search}#/recuperar`);
  const email = el('input', { type: 'email', required: true, placeholder: 'tu@correo.com', autocomplete: 'email' });
  const password = el('input', { type: 'password', required: true, minLength: 10, placeholder: 'Nueva contraseña', autocomplete: 'new-password' });
  const repeated = el('input', { type: 'password', required: true, minLength: 10, placeholder: 'Repite la nueva contraseña', autocomplete: 'new-password' });
  const estado = el('p', { class: 'auth-description', role: 'status', hidden: true });
  const solicitar = el('button', { class: 'auth-submit', type: 'submit' }, 'Enviar enlace de recuperación');
  const cambiar = el('button', { class: 'auth-submit', type: 'submit' }, 'Cambiar contraseña');
  const solicitud = el('form', { class: 'auth-form', hidden: !!linkedToken }, el('div', { class: 'auth-field' }, el('label', {}, 'Correo electrónico'), email), solicitar);
  const confirmacion = el('form', { class: 'auth-form', hidden: !linkedToken }, el('div', { class: 'auth-field' }, el('label', {}, 'Nueva contraseña'), password), el('div', { class: 'auth-field' }, el('label', {}, 'Confirmar contraseña'), repeated), cambiar);
  solicitud.onsubmit = async e => {
    e.preventDefault(); solicitar.disabled = true; solicitar.textContent = 'Enviando…';
    try {
      await api.solicitarRecuperacion(email.value.trim());
      estado.textContent = 'Si la cuenta existe, recibirás un enlace en tu correo. Revisa también la carpeta de spam. El enlace vence en una hora.';
      estado.className = 'auth-success'; estado.hidden = false;
    } catch (error) { estado.textContent = error.message; estado.className = 'auth-error'; estado.hidden = false; }
    finally { solicitar.disabled = false; solicitar.textContent = 'Enviar enlace de recuperación'; }
  };
  repeated.oninput = () => repeated.setCustomValidity('');
  confirmacion.onsubmit = async e => {
    e.preventDefault();
    if (password.value !== repeated.value) { repeated.setCustomValidity('Las contraseñas deben coincidir'); repeated.reportValidity(); return; }
    cambiar.disabled = true;
    try {
      await api.confirmarRecuperacion(linkedToken, password.value);
      password.value = ''; repeated.value = '';
      estado.textContent = 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.';
      estado.className = 'auth-success'; estado.hidden = false; confirmacion.hidden = true;
    } catch (error) { estado.textContent = error.message; estado.className = 'auth-error'; estado.hidden = false; }
    finally { cambiar.disabled = false; }
  };
  raiz.append(el('div', { class: 'auth-layout' }, el('section', { class: 'auth-story' }, el('a', { href: '#/login', class: 'auth-brand' }, '◒  FarmToTable'), el('div', { class: 'auth-story-copy' }, el('span', { class: 'auth-eyebrow' }, 'RECUPERA TU ACCESO'), el('h1', {}, 'Volvamos a', el('br'), el('em', {}, 'conectar.')), el('p', {}, 'Solicita un enlace seguro para establecer una nueva contraseña.'))), el('section', { class: 'auth-panel' }, el('nav', { class: 'auth-tabs' }, el('a', { href: '#/login' }, 'Iniciar sesión'), el('a', { href: '#/registro' }, 'Crear cuenta')), el('div', { class: 'auth-content' }, el('h2', {}, 'Restablecer contraseña'), el('p', { class: 'auth-description' }, linkedToken ? 'Elige una nueva contraseña de al menos 10 caracteres.' : 'Usa el correo asociado a tu cuenta.'), solicitud, confirmacion, estado, el('p', { class: 'auth-switch' }, el('a', { href: '#/login' }, 'Volver a iniciar sesión'))))));
}
