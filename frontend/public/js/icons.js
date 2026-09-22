// Juego de iconos en SVG. Trazo de 1.5, heredan currentColor y se escalan
// con el tamaño de fuente. Sin dependencias ni CDN.

const NS = 'http://www.w3.org/2000/svg';

const TRAZOS = {
  flujo: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
    ['path', { d: 'M10 6.5h4a3 3 0 0 1 3 3V14' }],
    ['path', { d: 'M6.5 10v4a3 3 0 0 0 3 3H14' }],
  ],
  productores: [
    ['circle', { cx: 9, cy: 8, r: 3 }],
    ['path', { d: 'M3 20a6 6 0 0 1 12 0' }],
    ['path', { d: 'M16 5.5a3 3 0 0 1 0 5' }],
    ['path', { d: 'M17.5 14.5A6 6 0 0 1 21 20' }],
  ],
  categorias: [
    ['path', { d: 'M3 11.2V4.6A1.6 1.6 0 0 1 4.6 3h6.6a1.6 1.6 0 0 1 1.13.47l7.2 7.2a1.6 1.6 0 0 1 0 2.26l-6.6 6.6a1.6 1.6 0 0 1-2.26 0l-7.2-7.2A1.6 1.6 0 0 1 3 11.2Z' }],
    ['circle', { cx: 7.5, cy: 7.5, r: 1.3 }],
  ],
  productos: [
    ['path', { d: 'M12 2.8 20.5 7v10L12 21.2 3.5 17V7Z' }],
    ['path', { d: 'M3.5 7 12 11.5 20.5 7' }],
    ['path', { d: 'M12 11.5v9.7' }],
  ],
  cosechas: [
    ['path', { d: 'M12 21V9' }],
    ['path', { d: 'M12 12c0-2.8 1.9-5 4.5-5 0 2.8-1.9 5-4.5 5Z' }],
    ['path', { d: 'M12 12C12 9.2 10.1 7 7.5 7c0 2.8 1.9 5 4.5 5Z' }],
    ['path', { d: 'M12 17c0-2.5 1.7-4.5 4-4.5 0 2.5-1.7 4.5-4 4.5Z' }],
    ['path', { d: 'M12 17c0-2.5-1.7-4.5-4-4.5 0 2.5 1.7 4.5 4 4.5Z' }],
  ],
  simulador: [
    ['path', { d: 'M4 6h9' }],
    ['path', { d: 'M17 6h3' }],
    ['circle', { cx: 15, cy: 6, r: 2 }],
    ['path', { d: 'M4 12h3' }],
    ['path', { d: 'M11 12h9' }],
    ['circle', { cx: 9, cy: 12, r: 2 }],
    ['path', { d: 'M4 18h9' }],
    ['path', { d: 'M17 18h3' }],
    ['circle', { cx: 15, cy: 18, r: 2 }],
  ],
  sistema: [
    ['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }],
    ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }],
    ['path', { d: 'M7 7.5h.01' }],
    ['path', { d: 'M7 16.5h.01' }],
    ['path', { d: 'M12 7.5h5' }],
    ['path', { d: 'M12 16.5h5' }],
  ],
  marca: [
    ['path', { d: 'M12 21v-8.5' }],
    ['path', { d: 'M12 12.5c0-4 2.8-7.2 7-7.2 0 4-2.8 7.2-7 7.2Z' }],
    ['path', { d: 'M12 16.8C12 13.6 9.7 11 6 11c0 3.2 2.3 5.8 6 5.8Z' }],
  ],
  tema: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }],
  ],
  salir: [
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
    ['path', { d: 'M16 17l5-5-5-5' }],
    ['path', { d: 'M21 12H9' }],
  ],
  entrar: [
    ['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' }],
    ['path', { d: 'M10 17l5-5-5-5' }],
    ['path', { d: 'M15 12H3' }],
  ],
  copiar: [
    ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
  ],
  refrescar: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }],
    ['path', { d: 'M21 4v5h-5' }],
  ],
  mas: [['path', { d: 'M12 5v14M5 12h14' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  alerta: [
    ['path', { d: 'M12 3.5 22 20H2Z' }],
    ['path', { d: 'M12 10v4' }],
    ['path', { d: 'M12 17.2h.01' }],
  ],
  reproducir: [['path', { d: 'M6 4.5v15l13-7.5Z' }]],
  reiniciar: [
    ['path', { d: 'M3 12a9 9 0 1 0 2.64-6.36' }],
    ['path', { d: 'M3 4v5h5' }],
  ],
  filtro: [['path', { d: 'M3 5h18l-7 8v6l-4 2v-8Z' }]],
  base: [
    ['ellipse', { cx: 12, cy: 5.5, rx: 8, ry: 3 }],
    ['path', { d: 'M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13' }],
    ['path', { d: 'M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3' }],
  ],
  cola: [
    ['rect', { x: 2.5, y: 8, width: 5, height: 8, rx: 1.2 }],
    ['rect', { x: 9.5, y: 8, width: 5, height: 8, rx: 1.2 }],
    ['path', { d: 'M17 12h4' }],
    ['path', { d: 'M18.5 9.5 21 12l-2.5 2.5' }],
  ],
  reloj: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3 2' }],
  ],
};

/** Devuelve un <svg> del icono pedido. */
export function icono(nombre, { tam = 18, clase = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', tam);
  svg.setAttribute('height', tam);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (clase) svg.setAttribute('class', clase);

  for (const [etiqueta, atributos] of TRAZOS[nombre] ?? TRAZOS.alerta) {
    const nodo = document.createElementNS(NS, etiqueta);
    for (const [k, v] of Object.entries(atributos)) nodo.setAttribute(k, String(v));
    svg.append(nodo);
  }
  return svg;
}

/** Icono relleno para estados sólidos (puntos, marcas). */
export function punto(clase = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('width', '8');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  if (clase) svg.setAttribute('class', clase);
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', '4');
  c.setAttribute('cy', '4');
  c.setAttribute('r', '4');
  c.setAttribute('fill', 'currentColor');
  svg.append(c);
  return svg;
}
