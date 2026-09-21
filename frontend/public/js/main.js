// Arranque: tema, sesión, barra de salud y enrutado por hash.

import { api, sesion } from './api.js';
import { estado } from './state.js';
import { icono, punto } from './icons.js';
import { avisarError, aviso, boton, el, seleccion, vaciar } from './ui.js';
import { vistaFlujo } from './views/flujo.js';
import { vistaProductores } from './views/productores.js';
import { vistaCategorias } from './views/categorias.js';
import { vistaProductos } from './views/productos.js';
import { vistaCosechas } from './views/cosechas.js';
import { vistaSimulador } from './views/simulador.js';
import { vistaSistema } from './views/sistema.js';

const VISTAS = {
  flujo: vistaFlujo,
  productores: vistaProductores,
  categorias: vistaCategorias,
  productos: vistaProductos,
  cosechas: vistaCosechas,
  simulador: vistaSimulador,
  sistema: vistaSistema,
};

// ═══════════════════════════════════════════════════════════════ iconos

document.getElementById('marca-sello').append(icono('marca', { tam: 19 }));

for (const enlace of document.querySelectorAll('#nav a[data-icono]')) {
  enlace.prepend(icono(enlace.dataset.icono, { tam: 16 }));
}

// ═════════════════════════════════════════════════════════════════ tema

const btnTema = document.getElementById('btn-tema');
btnTema.append(icono('tema', { tam: 16 }));

const temaGuardado = leerTema();
if (temaGuardado) document.documentElement.dataset.tema = temaGuardado;

btnTema.addEventListener('click', () => {
  const actual = document.documentElement.dataset.tema;
  const oscuroPorSistema = matchMedia('(prefers-color-scheme: dark)').matches;
  const siguiente = actual ? (actual === 'oscuro' ? 'claro' : 'oscuro') : oscuroPorSistema ? 'claro' : 'oscuro';
  document.documentElement.dataset.tema = siguiente;
  try {
    localStorage.setItem('ftt_tema', siguiente);
  } catch {
    /* en ventana privada el tema no se recuerda; no es un problema */
  }
});

function leerTema() {
  try {
    return localStorage.getItem('ftt_tema');
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════ sesión

const cajaSesion = document.getElementById('sesion-caja');

function pintarSesion() {
  vaciar(cajaSesion);

  if (!sesion.activa) {
    const selector = seleccion('role', [['producer', 'Productor'], ['admin', 'Administrador']]);
    const btn = boton(
      'Iniciar sesión',
      async () => {
        btn.disabled = true;
        try {
          const rol = selector.value;
          // Se reutiliza la identidad anterior de ese rol: así el perfil de
          // productor creado en una sesión previa sigue siendo el suyo.
          const r = await api.login(rol, sesion.identidadRecordada(rol));
          sesion.guardar(r);
          sesion.recordarIdentidad(rol, r.user_id);
          aviso('Sesión iniciada', `Rol ${r.roles.join(', ')}`);
          pintarSesion();
          enrutar();
        } catch (err) {
          avisarError(err, 'No se pudo iniciar sesión');
        } finally {
          btn.disabled = false;
        }
      },
      'btn',
      'entrar',
    );

    cajaSesion.append(
      el('p', { class: 'sesion-titulo' }, 'Sesión'),
      el('div', { class: 'campo', style: 'gap:8px' }, selector, btn),
      el('p', { class: 'pista', style: 'margin:10px 0 0;font-size:11px' },
        'El token lo emite la Identidad simulada del Gateway. Los microservicios solo lo verifican.'),
    );
    return;
  }

  cajaSesion.append(
    el('p', { class: 'sesion-titulo' }, 'Sesión'),
    el(
      'div',
      { class: 'sesion-caja' },
      el(
        'div',
        { class: 'sesion-fila' },
        el('span', { class: `insignia ${sesion.esAdmin ? 'info' : 'ok'}` }, sesion.esAdmin ? 'Administrador' : 'Productor'),
        boton('Salir', () => {
          sesion.cerrar();
          estado.limpiar();
          aviso('Sesión cerrada', '', 'info', 2000);
          pintarSesion();
          enrutar();
        }, 'btn btn-sutil btn-chico', 'salir'),
      ),
      el('span', { class: 'sesion-uid', title: sesion.userId }, sesion.userId),
    ),
  );
}

// ════════════════════════════════════════════════════════════════ salud

const cajaSalud = document.getElementById('salud');

async function pintarSalud() {
  try {
    const salud = await api.salud();
    vaciar(cajaSalud).append(
      Object.entries(salud).map(([nombre, s]) => {
        const listo = s.alcanzable && s.listo;
        const clase = listo ? 'punto-ok' : s.alcanzable ? 'punto-tibio' : 'punto-mal';
        const detalle = Object.entries(s.checks ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
        return el(
          'span',
          { class: 'salud-item', title: detalle || s.detalle || '' },
          punto(clase),
          nombre.replace('-service', ''),
        );
      }),
    );
  } catch {
    vaciar(cajaSalud).append(
      el('span', { class: 'salud-item' }, punto('punto-mal'), 'Gateway sin respuesta'),
    );
  }
}

// ═════════════════════════════════════════════════════════════ enrutado

const zonaVista = document.getElementById('vista');

function vistaActual() {
  const nombre = (location.hash.replace(/^#\/?/, '') || 'flujo').split('/')[0];
  return VISTAS[nombre] ? nombre : 'flujo';
}

async function enrutar() {
  const nombre = vistaActual();

  for (const enlace of document.querySelectorAll('#nav a')) {
    const activo = enlace.dataset.vista === nombre;
    enlace.classList.toggle('activo', activo);
    if (activo) enlace.setAttribute('aria-current', 'page');
    else enlace.removeAttribute('aria-current');
  }

  vaciar(zonaVista);

  if (!sesion.activa && nombre !== 'sistema') {
    zonaVista.append(
      el('h1', {}, 'Inicie sesión para continuar'),
      el('p', { class: 'subtitulo' },
        'Los dos microservicios exigen un JWT válido en toda ruta que no sea /health. ' +
        'Pida un token a la Identidad simulada desde el panel de la izquierda. ' +
        'Elija «Administrador» si necesita reactivar productores.'),
    );
    return;
  }

  try {
    await VISTAS[nombre](zonaVista);
  } catch (err) {
    avisarError(err, 'No se pudo cargar la vista');
    vaciar(zonaVista).append(el('div', { class: 'vacio' }, 'Error al cargar esta sección'));
  }
}

addEventListener('hashchange', enrutar);

pintarSesion();
enrutar();
pintarSalud();
setInterval(pintarSalud, 15000);
