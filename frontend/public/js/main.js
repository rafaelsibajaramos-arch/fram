import { api, sesion } from './api.js';
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

const vistas = { productores: vistaProductores, categorias: vistaCategorias, productos: vistaProductos, cosechas: vistaCosechas, pedidos: vistaPedidos, sistema: vistaSistema, validaciones: vistaValidaciones, roles: vistaRoles };
const permisos = { admin: Object.keys(vistas), producer: ['productores', 'productos', 'cosechas'], buyer: ['productos', 'pedidos'] };
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
const inicio = () => sesion.esAdmin ? 'validaciones' : sesion.roles.includes('producer') ? 'productores' : 'productos';
async function salir() { try { await api.cerrarSesion(); } catch { /* el cierre local no debe bloquear al usuario */ } sesion.cerrar(); estado.limpiar(); location.hash = '#/login'; await enrutar(); }
function pintarMarco(nombre) {
  document.body.classList.toggle('modo-acceso', !sesion.activa);
  const allowed = new Set(sesion.roles.flatMap(r => permisos[r] ?? []));
  for (const a of document.querySelectorAll('#nav a')) { a.hidden = !allowed.has(a.dataset.vista); a.classList.toggle('activo', a.dataset.vista === nombre); }
  for (const grupo of document.querySelectorAll('#nav .nav-grupo')) grupo.hidden = true;
  const caja = vaciar(document.getElementById('sesion-caja'));
  if (sesion.activa) caja.append(el('p', { class: 'sesion-titulo' }, sesion.esAdmin ? 'Administrador' : sesion.roles.includes('producer') ? 'Productor' : 'Comprador'), boton('Cerrar sesión', salir, 'btn btn-sutil'));
  document.getElementById('salud').textContent = 'Tu espacio FarmToTable';
}
async function enrutar() {
  const turno = ++render;
  let nombre = location.hash.replace(/^#\/?/, '').split('/')[0].split('?')[0] || (sesion.activa ? inicio() : 'login');
  pintarMarco(nombre);
  vaciar(zona);
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
    if (error.status === 401) { await salir(); return; }
    avisarError(error, 'No se pudo cargar la sección');
    vaciar(contenido).append(el('p', {}, 'No pudimos cargar esta sección.'), boton('Reintentar', enrutar));
  }
}
addEventListener('hashchange', enrutar);
addEventListener('ftt:expired', salir);
async function iniciar() {
  if (sesion.activa) {
    try { const user = await api.miCuenta(); sesion.guardar({ token: sesion.token, user_id: user.id, roles: user.roles }); }
    catch (error) { try { const refreshed = await api.renovar(); sesion.guardar(refreshed); } catch { sesion.cerrar(); if (error.status !== 401) avisarError(error, 'No se pudo comprobar la sesión'); } }
  }
  await enrutar();
}
void iniciar();
