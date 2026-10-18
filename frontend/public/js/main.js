import { api, sesion } from './api.js';
import { instalarCarrito } from './carrito.js';
import { estado } from './state.js';
import { icono } from './icons.js';
import { avisarError, boton, el, vaciar } from './ui.js';
import { vistaAcceso } from './views/acceso.js';
import { vistaRecuperar } from './views/recuperar.js';
import { vistaProductores } from './views/productores.js';
import { vistaCategorias } from './views/categorias.js';
import { vistaProductos } from './views/productos.js';
import { vistaCosechas } from './views/cosechas.js';
import { vistaSistema } from './views/sistema.js';
import { vistaValidaciones } from './views/validaciones.js';
import { vistaRoles } from './views/roles.js';
import { vistaPedidos } from './views/pedidos.js';
import { vistaTarjetas } from './views/tarjetas.js';
import { vistaNotificaciones } from './views/notificaciones.js';
import { vistaAnalitica } from './views/analitica.js';
import { vistaLiquidaciones } from './views/liquidaciones.js';
import { vistaSolicitudProductor } from './views/solicitud-productor.js';
import { vistaSolicitudesProductor } from './views/solicitudes-productor.js';
import { vistaLogistica, vistaEntregas } from './views/logistica.js';

const vistas = { productores: vistaProductores, categorias: vistaCategorias, productos: vistaProductos, cosechas: vistaCosechas, pedidos: vistaPedidos, tarjetas: vistaTarjetas, liquidaciones: vistaLiquidaciones, notificaciones: vistaNotificaciones, analitica: vistaAnalitica, sistema: vistaSistema, validaciones: vistaValidaciones, roles: vistaRoles, 'solicitud-productor': vistaSolicitudProductor, 'solicitudes-productor': vistaSolicitudesProductor };
const permisos = { admin: Object.keys(vistas).filter((vista) => vista !== 'solicitud-productor'), producer: ['productores', 'productos', 'cosechas', 'pedidos', 'liquidaciones', 'notificaciones'], buyer: ['productos', 'pedidos', 'tarjetas', 'notificaciones', 'solicitud-productor'] };
vistas.logistica = vistaLogistica;
vistas.entregas = vistaEntregas;
permisos.admin.push('logistica', 'entregas');
permisos.buyer.push('entregas');
permisos.driver = ['logistica', 'notificaciones'];
permisos.logistics_admin = ['logistica', 'entregas', 'notificaciones'];
const zona = document.getElementById('vista');
let render = 0;
document.getElementById('marca-sello').append(icono('marca', { tam: 19 }));
for (const a of document.querySelectorAll('#nav a[data-icono]')) a.prepend(icono(a.dataset.icono, { tam: 16 }));
const tema = document.getElementById('btn-tema');
tema.append(icono('tema', { tam: 16 }));
document.documentElement.dataset.tema = localStorage.getItem('ftt_tema') || 'claro';
tema.onclick = () => {
  const value = document.documentElement.dataset.tema === 'oscuro' ? 'claro' : 'oscuro';
  document.documentElement.dataset.tema = value; localStorage.setItem('ftt_tema', value);
};
const carrito = document.getElementById('btn-carrito');
instalarCarrito(carrito, async () => { location.hash = '#/pedidos'; await enrutar(); });
const inicio = () => sesion.esAdmin ? 'validaciones' : sesion.roles.some(r => ['driver', 'logistics_admin'].includes(r)) ? 'logistica' : sesion.roles.includes('producer') ? 'productores' : 'productos';
async function salir() { try { await api.cerrarSesion(); } catch { /* el cierre local no debe bloquear al usuario */ } sesion.cerrar(); estado.limpiar(); location.hash = '#/login'; await enrutar(); }
function pintarMarco(nombre) {
  document.body.classList.toggle('modo-acceso', !sesion.activa || nombre === 'recuperar');
  carrito.hidden = !sesion.activa || nombre === 'recuperar' || !sesion.roles.some(role => ['buyer', 'admin'].includes(role));
  const allowed = new Set(sesion.roles.flatMap(r => permisos[r] ?? []));
  for (const a of document.querySelectorAll('#nav a')) { a.hidden = !allowed.has(a.dataset.vista); a.classList.toggle('activo', a.dataset.vista === nombre); }
  for (const grupo of document.querySelectorAll('#nav .nav-grupo')) grupo.hidden = true;
  const caja = vaciar(document.getElementById('sesion-caja'));
  if (sesion.activa) caja.append(el('p', { class: 'sesion-titulo' }, sesion.esAdmin ? 'Administrador' : sesion.roles.includes('logistics_admin') ? 'Coordinador logístico' : sesion.roles.includes('driver') ? 'Transportista' : sesion.roles.includes('producer') ? 'Productor' : 'Comprador'), boton('Cerrar sesión', salir, 'btn btn-sutil'));
  document.getElementById('salud').textContent = 'Tu espacio FarmToTable';
}
async function enrutar() {
  const turno = ++render;
  let nombre = location.hash.replace(/^#\/?/, '').split('/')[0].split('?')[0] || (sesion.activa ? inicio() : 'login');
  pintarMarco(nombre);
  vaciar(zona);
  if (nombre === 'recuperar') { vistaRecuperar(zona); return; }
  if (!sesion.activa) {
    if (nombre === 'recuperar') { vistaRecuperar(zona); return; }
    vistaAcceso(zona, nombre === 'registro', async () => { estado.limpiar(); location.hash = '#/' + inicio(); await enrutar(); });
    return;
  }
  const allowed = new Set(sesion.roles.flatMap(r => permisos[r] ?? []));
  if (!allowed.has(nombre)) { location.hash = '#/' + inicio(); return; }
  const contenido = el('div', {}); zona.append(contenido);
  try { await vistas[nombre](contenido); }
  catch (error) {
    if (turno !== render) return;
    // Un 401 de un microservicio no invalida por sí solo la sesión de Identity.
    // api.js la cierra solo si el servidor también rechaza el refresh token.
    if (error.status === 401 && !sesion.activa) { await salir(); return; }
    avisarError(error, 'No se pudo cargar la sección');
    vaciar(contenido).append(el('p', {}, 'No pudimos cargar esta sección.'), boton('Reintentar', enrutar));
  }
}
addEventListener('hashchange', enrutar);
addEventListener('ftt:expired', salir);
async function iniciar() {
  if (sesion.activa) {
    try { const user = await api.miCuenta(); sesion.guardar({ token: sesion.token, user_id: user.id, roles: user.roles }); }
    catch (error) { if (sesion.activa) avisarError(error, 'No se pudo comprobar la sesión'); }
  }
  await enrutar();
}
void iniciar();
