import { api, sesion } from '../api.js';
import { el, boton } from '../ui.js';
export function vistaAcceso(raiz, registro, alEntrar) {
  const campo = (label, name, type, autocomplete) => {
    const input = el('input', { id: name, name, type, autocomplete, required: true });
    return { input, nodo: el('div', { class: 'auth-field' }, el('label', { htmlFor: name }, label), input) };
  };
  const nombre = campo('Nombre completo', 'full_name', 'text', 'name');
  const correo = campo('Correo electrónico', 'email', 'email', 'email');
  const clave = campo('Contraseña', 'password', 'password', registro ? 'new-password' : 'current-password');
  const confirmar = campo('Confirmar contraseña', 'confirm', 'password', 'new-password');
  correo.input.placeholder = 'tu@correo.com';
  nombre.input.maxLength = 150;
  clave.input.maxLength = 72;
  if (registro) clave.input.minLength = 10;
  const mostrar = boton('Mostrar', () => {
    const visible = clave.input.type === 'password';
    clave.input.type = visible ? 'text' : 'password';
    mostrar.textContent = visible ? 'Ocultar' : 'Mostrar';
    mostrar.setAttribute('aria-pressed', String(visible));
  }, 'auth-reveal');
  clave.nodo.append(mostrar);
  const error = el('div', { class: 'auth-error', role: 'alert', hidden: true, tabIndex: -1 });
  const submit = el('button', { type: 'submit', class: 'auth-submit' }, registro ? 'Crear mi cuenta →' : 'Entrar a mi cuenta →');
  const form = el('form', { class: 'auth-form' }, registro ? nombre.nodo : null, correo.nodo, clave.nodo,
    registro ? el('small', {}, 'Usa entre 10 y 72 caracteres.') : null,
    registro ? confirmar.nodo : null, error, submit);
  confirmar.input.oninput = () => confirmar.input.setCustomValidity('');
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.disabled) return;
    if (registro && clave.input.value !== confirmar.input.value) { confirmar.input.setCustomValidity('Las contraseñas no coinciden'); confirmar.input.reportValidity(); return; }
    error.hidden = true; submit.disabled = true; submit.textContent = 'Un momento…';
    try {
      if (registro) {
        const creado = await api.registrar({ full_name: nombre.input.value.trim(), email: correo.input.value.trim(), password: clave.input.value });
        if (creado.verification_token) await api.verificarCorreo(creado.verification_token);
        else throw new Error('Revisa tu correo y verifica la cuenta antes de iniciar sesión.');
      }
      const access = await api.autenticar(correo.input.value.trim(), clave.input.value);
      sesion.guardar(access); await alEntrar();
    } catch (err) {
      error.textContent = err.status === 401 ? 'El correo o la contraseña no son correctos.' : err.status >= 500 ? 'No pudimos conectar. Intenta nuevamente en unos momentos.' : err.message;
      error.hidden = false; error.focus();
    } finally { submit.disabled = false; submit.textContent = registro ? 'Crear mi cuenta →' : 'Entrar a mi cuenta →'; }
  };
  raiz.append(el('div', { class: 'auth-layout' },
    el('section', { class: 'auth-story' },
      el('a', { href: '#/login', class: 'auth-brand' }, '◒  FarmToTable'),
      el('div', { class: 'auth-story-copy' }, el('span', { class: 'auth-eyebrow' }, 'DEL CAMPO A TU MESA'),
        el('h1', {}, 'Lo bueno empieza', el('br'), el('em', {}, 'en la tierra.')),
        el('p', {}, 'Un espacio para conectar a quienes cultivan con quienes valoran el origen de sus alimentos.')),
      el('div', { class: 'auth-landscape', 'aria-hidden': 'true' }, el('div', { class: 'auth-sun' }), el('div', { class: 'auth-field-art' })),
      el('footer', {}, 'Origen cercano. Relaciones que crecen.')),
    el('section', { class: 'auth-panel' },
      el('nav', { class: 'auth-tabs', 'aria-label': 'Acceso' }, el('a', { href: '#/login', class: !registro ? 'selected' : '' }, 'Iniciar sesión'), el('a', { href: '#/registro', class: registro ? 'selected' : '' }, 'Crear cuenta')),
      el('div', { class: 'auth-content' }, el('span', { class: 'auth-eyebrow' }, registro ? 'SÉ PARTE DE LA COMUNIDAD' : 'QUÉ BUENO TENERTE AQUÍ'),
        el('h2', {}, registro ? 'Cultivemos conexiones.' : 'Bienvenido de nuevo.'),
        el('p', { class: 'auth-description' }, registro ? 'Crea tu cuenta de comprador. El perfil productor se asigna tras la validación administrativa.' : 'Ingresa tus datos para continuar a tu espacio.'),
        form, !registro ? el('p', { class: 'auth-switch' }, el('a', { href: '#/recuperar' }, '¿Olvidaste tu contraseña?')) : null, el('p', { class: 'auth-switch' }, registro ? '¿Ya tienes cuenta? ' : '¿Es tu primera visita? ', el('a', { href: registro ? '#/login' : '#/registro' }, registro ? 'Inicia sesión' : 'Crea tu cuenta')),
        el('p', { class: 'auth-footnote' }, 'Tu acceso es personal. Los permisos se asignan según tu cuenta.')))));
}
