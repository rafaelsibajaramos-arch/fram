// Estado de la infraestructura: salud de los servicios y colas de RabbitMQ.

import { api } from '../api.js';
import { avisarError, boton, cargando, el, tabla, tarjeta, vaciar } from '../ui.js';

export async function vistaSistema(raiz) {
  raiz.append(
    el('h1', {}, 'Sistema'),
    el('p', { class: 'subtitulo' },
      'PostgreSQL y RabbitMQ son esenciales para los dos servicios. Redis es solo caché: si cae, ' +
      'el catálogo sigue listo y lee de PostgreSQL.'),
  );

  const zonaSalud = el('div', {});
  const zonaColas = el('div', {});
  raiz.append(zonaSalud, zonaColas);

  async function refrescar() {
    await Promise.all([refrescarSalud(), refrescarColas()]);
  }

  async function refrescarSalud() {
    vaciar(zonaSalud).append(cargando());
    try {
      const salud = await api.salud();
      vaciar(zonaSalud).append(
        tarjeta(
          'Servicios',
          el(
            'div',
            { class: 'rejilla' },
            Object.entries(salud).map(([nombre, s]) => tarjetaServicio(nombre, s)),
          ),
          { accion: boton('Actualizar', refrescar, 'btn btn-sutil btn-chico', 'refrescar') },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudo consultar la salud');
      vaciar(zonaSalud);
    }
  }

  async function refrescarColas() {
    vaciar(zonaColas).append(cargando());
    try {
      const { colas } = await api.colas();
      const normales = colas.filter((c) => !c.dlq);
      const muertas = colas.filter((c) => c.dlq);

      vaciar(zonaColas).append(
        tarjeta(
          'Colas de RabbitMQ',
          el(
            'div',
            {},
            tabla(
              [
                { titulo: 'Cola', celda: (c) => el('span', { class: 'mono' }, c.nombre) },
                { titulo: 'Listos', celda: (c) => c.listos, num: true },
                { titulo: 'Sin confirmar', celda: (c) => c.sin_confirmar, num: true },
                {
                  titulo: 'Consumidores',
                  celda: (c) =>
                    el('span', { class: `insignia ${c.consumidores > 0 ? 'ok' : 'mal'}` }, String(c.consumidores)),
                },
              ],
              normales,
              { vacio: 'Sin colas. ¿RabbitMQ está levantado?' },
            ),
            el('p', { class: 'pista', style: 'margin-top:14px' },
              'Cada cola debe tener 1 consumidor. Si marca 0, ese servicio está caído y los eventos ' +
              'se acumularán en «Listos» hasta que vuelva.'),
            muertas.length
              ? el(
                  'div',
                  { style: 'margin-top:16px' },
                  el('h2', {}, 'Colas de mensajes fallidos'),
                  tabla(
                    [
                      { titulo: 'Cola', celda: (c) => el('span', { class: 'mono' }, c.nombre) },
                      {
                        titulo: 'Mensajes',
                        celda: (c) =>
                          el('span', { class: `insignia ${c.listos > 0 ? 'mal' : 'ok'}` }, String(c.listos)),
                        num: true,
                      },
                    ],
                    muertas,
                  ),
                  el('p', { class: 'pista' },
                    'Un mensaje que falla dos veces acaba aquí en lugar de bloquear la cola. ' +
                    'Con todo en cero, no hay nada que revisar a mano.'),
                )
              : null,
          ),
        ),
      );
    } catch (err) {
      vaciar(zonaColas).append(
        tarjeta('Colas de RabbitMQ', el('div', { class: 'vacio' },
          err.message ?? 'RabbitMQ no está disponible')),
      );
    }
  }

  await refrescar();

  // Refresco automático mientras la vista siga montada.
  const reloj = setInterval(() => {
    if (!document.body.contains(zonaSalud)) return clearInterval(reloj);
    refrescar();
  }, 10000);
}

function tarjetaServicio(nombre, s) {
  const listo = s.alcanzable && s.listo;
  const chequeos = Object.entries(s.checks ?? {});

  return el(
    'div',
    { class: 'tarjeta', style: 'margin:0' },
    el(
      'div',
      { class: 'tarjeta-cabecera' },
      el('h2', { class: 'mono' }, nombre),
      el('span', { class: `insignia ${listo ? 'ok' : 'mal'}` }, listo ? 'listo' : `no listo (${s.http || 'sin respuesta'})`),
    ),
    chequeos.length
      ? el(
          'div',
          { class: 'acciones', style: 'margin:0' },
          chequeos.map(([k, v]) =>
            el('span', { class: `insignia ${v === 'up' ? 'ok' : v.startsWith('down (op') ? 'aviso' : v === 'desactivado' ? 'neutra' : 'mal'}` },
              `${k}: ${v}`),
          ),
        )
      : el('p', { class: 'pista', style: 'margin:0' }, s.detalle ?? 'Sin detalle'),
  );
}
