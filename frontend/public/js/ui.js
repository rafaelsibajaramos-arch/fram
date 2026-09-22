// Ayudas de interfaz: creación de nodos, tablas, avisos y formato.

import { ErrorApi } from './api.js';
import { icono, punto } from './icons.js';

/** Crea un nodo. Los hijos pueden ser nodos, texto o null. */
export function el(etiqueta, props = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k === 'html') nodo.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') nodo.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(nodo.dataset, v);
    else if (k in nodo && k !== 'list') nodo[k] = v;
    else nodo.setAttribute(k, v);
  }
  for (const h of hijos.flat()) {
    if (h === null || h === undefined || h === false) continue;
    nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  }
  return nodo;
}

export function vaciar(nodo) {
  while (nodo.firstChild) nodo.firstChild.remove();
  return nodo;
}

// ═══════════════════════════════════════════════════════════════ avisos

const ICONO_AVISO = { ok: 'check', mal: 'alerta', info: 'reloj' };

export function aviso(titulo, detalle = '', tipo = 'ok', ms = 4200) {
  const t = el(
    'div',
    { class: `toast ${tipo}` },
    icono(ICONO_AVISO[tipo] ?? 'check', { tam: 16, clase: 'toast-icono' }),
    el('div', { class: 'toast-texto' }, el('strong', {}, titulo), detalle ? el('span', {}, detalle) : null),
  );
  document.getElementById('toasts').append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(4px)';
    setTimeout(() => t.remove(), 220);
  }, ms);
}

/** Traduce un error de la API a un aviso legible. */
export function avisarError(err, contexto = 'Operación fallida') {
  if (err instanceof ErrorApi) {
    const pistas = {
      401: 'Falta iniciar sesión o el token caducó',
      403: 'El recurso pertenece a otro productor',
      404: 'No existe',
      409: 'Conflicto con el estado actual',
      422: 'Datos inválidos',
      429: 'Demasiadas peticiones',
      503: 'El microservicio no está disponible',
      504: 'El microservicio no respondió a tiempo',
    };
    aviso(`${err.status} · ${contexto}`, err.message || pistas[err.status] || '', 'mal', 6500);
  } else {
    aviso(contexto, err.message ?? String(err), 'mal', 6500);
  }
  console.error(contexto, err);
}

// ══════════════════════════════════════════════════════════════ formato

export const fmtDinero = (n) =>
  n === null || n === undefined
    ? '—'
    : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(n);

export const fmtKg = (n) =>
  n === null || n === undefined
    ? '—'
    : `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(n)} kg`;

export function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

export const corto = (id) => (id ? `${id.slice(0, 8)}` : '—');

/** Chip con el UUID abreviado: al pulsarlo lo copia entero. */
export function chipId(id) {
  if (!id) return el('span', { class: 'mono' }, '—');
  return el(
    'button',
    {
      class: 'chip-id',
      type: 'button',
      title: `${id} — pulse para copiar`,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(id);
          aviso('Identificador copiado', id, 'info', 2200);
        } catch {
          aviso('No se pudo copiar', 'El navegador bloqueó el portapapeles', 'mal', 2600);
        }
      },
    },
    corto(id),
    icono('copiar', { tam: 11 }),
  );
}

const ETIQUETAS = {
  active: ['ok', 'Activo'],
  disabled: ['mal', 'Inactivo'],
  valid: ['ok', 'Vigente'],
  expired: ['aviso', 'Vencida'],
  revoked: ['mal', 'Revocada'],
  registered: ['neutra', 'Registrado'],
  published: ['ok', 'Publicado'],
  closed: ['aviso', 'Cerrado'],
  initial: ['neutra', 'Inicial'],
  low_stock: ['aviso', 'Stock bajo'],
  high_stock: ['info', 'Stock alto'],
  normal_stock: ['ok', 'Stock normal'],
  base_change: ['info', 'Cambio de base'],
};

export function insignia(valor) {
  const [clase, texto] = ETIQUETAS[valor] ?? ['neutra', valor ?? '—'];
  return el('span', { class: `insignia ${clase}` }, texto);
}

export const insigniaBool = (v, si = 'Activo', no = 'Inactivo') =>
  el('span', { class: `insignia ${v ? 'ok' : 'mal'}` }, v ? si : no);

export const etiquetaSimple = (texto, clase = 'neutra') =>
  el('span', { class: `insignia ${clase} sin-punto` }, texto);

// ═══════════════════════════════════════════════════════════════ tablas

/**
 * Tabla sencilla. `columnas` = [{ titulo, celda(fila), num }]
 * `alElegir` marca la fila pulsada.
 */
export function tabla(columnas, filas, { alElegir, elegida, vacio = 'Sin datos' } = {}) {
  if (!filas?.length) return el('div', { class: 'tabla-caja' }, el('div', { class: 'vacio' }, vacio));

  return el(
    'div',
    { class: 'tabla-caja' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, columnas.map((c) => el('th', { class: c.num ? 'num' : '' }, c.titulo)))),
      el(
        'tbody',
        {},
        filas.map((fila) =>
          el(
            'tr',
            {
              class: elegida && elegida(fila) ? 'elegida' : '',
              style: alElegir ? 'cursor:pointer' : '',
              ...(alElegir ? { onclick: () => alElegir(fila) } : {}),
            },
            columnas.map((c) => el('td', { class: c.num ? 'num' : '' }, c.celda(fila))),
          ),
        ),
      ),
    ),
  );
}

// ════════════════════════════════════════════════════════════ estructura

/** Tarjeta con cabecera opcional; el contenido va siempre en su cuerpo. */
export function tarjeta(titulo, contenido, { accion, pista } = {}) {
  return el(
    'section',
    { class: 'tarjeta' },
    titulo
      ? el('div', { class: 'tarjeta-cabecera' }, el('h2', {}, titulo), accion ?? null)
      : null,
    el('div', { class: 'tarjeta-cuerpo' }, pista ? el('p', { class: 'pista' }, pista) : null, contenido),
  );
}

export function campo(etiqueta, entrada, ayuda) {
  return el('div', { class: 'campo' }, el('label', {}, etiqueta), entrada, ayuda ? el('small', {}, ayuda) : null);
}

export function entrada(nombre, props = {}) {
  return el('input', { name: nombre, autocomplete: 'off', ...props });
}

export function seleccion(nombre, opciones, props = {}) {
  return el(
    'select',
    { name: nombre, ...props },
    opciones.map(([valor, texto]) => el('option', { value: valor }, texto)),
  );
}

/** Botón. `nombreIcono` antepone un icono SVG. */
export function boton(texto, alPulsar, clase = 'btn', nombreIcono) {
  return el(
    'button',
    { class: clase, type: 'button', onclick: alPulsar },
    nombreIcono ? icono(nombreIcono, { tam: clase.includes('btn-chico') ? 13 : 15 }) : null,
    texto,
  );
}

/** Fila de acciones pegada al pie de una tarjeta. */
export const pie = (...nodos) => el('div', { class: 'acciones acciones-pie' }, ...nodos);

export const cargando = (texto = 'Cargando') =>
  el('div', { class: 'cargando' }, icono('refrescar', { tam: 15, clase: 'girando' }), texto);

/** Lee los valores de un formulario y descarta los vacíos. */
export function valores(raiz) {
  const salida = {};
  for (const campoEl of raiz.querySelectorAll('input, select, textarea')) {
    if (!campoEl.name) continue;
    let v = campoEl.value;
    if (campoEl.type === 'checkbox') v = campoEl.checked;
    else if (campoEl.type === 'number') v = v === '' ? undefined : Number(v);
    else if (typeof v === 'string') v = v.trim() === '' ? undefined : v.trim();
    if (v !== undefined) salida[campoEl.name] = v;
  }
  return salida;
}

/**
 * Bloque para estados en los que falta un paso previo: explica qué falta y
 * ofrece el atajo para resolverlo, en lugar de dejar que la API responda 422.
 */
export function bloqueAviso(titulo, texto, accion) {
  return el(
    'div',
    { class: 'bloque-aviso' },
    icono('alerta', { tam: 18, clase: 'bloque-aviso-icono' }),
    el(
      'div',
      {},
      el('strong', {}, titulo),
      el('p', {}, texto),
      accion ? el('div', { class: 'acciones', style: 'margin-top:10px' }, accion) : null,
    ),
  );
}

/**
 * Comprueba los campos obligatorios antes de llamar a la API.
 * `requeridos` = [[valor, 'etiqueta'], ...]. Devuelve true si falta alguno.
 */
export function faltanDatos(requeridos) {
  const faltan = requeridos.filter(([v]) => v === undefined || v === null || v === '').map(([, n]) => n);
  if (!faltan.length) return false;
  aviso('Faltan datos', `Complete: ${faltan.join(', ')}`, 'mal', 4000);
  return true;
}

/** Enlace que parece un botón, para saltar a otra sección. */
export const enlaceBoton = (texto, hash, clase = 'btn btn-sec', nombreIcono) =>
  el('a', { class: clase, href: hash, style: 'text-decoration:none' },
    nombreIcono ? icono(nombreIcono, { tam: 15 }) : null, texto);

/** Par etiqueta/valor para fichas de detalle. */
export const dato = (etiqueta, valor) =>
  el('div', { class: 'dato' }, el('span', { class: 'dato-etiqueta' }, etiqueta),
    el('span', { class: 'dato-valor' }, valor));

export { icono, punto };
