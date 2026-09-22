// Simuladores de los microservicios que no están en este alcance:
// inventory-service e identity-service. Publican eventos reales en RabbitMQ.

import { api, sesion } from '../api.js';
import { estado } from '../state.js';
import {
  avisarError, aviso, boton, campo, el, entrada, fmtDinero, fmtKg,
  insignia, pie, seleccion, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaSimulador(raiz) {
  raiz.append(
    el('h1', {}, 'Simulador'),
    el('p', { class: 'subtitulo' },
      'Inventario e Identidad son microservicios aparte que no forman parte de este alcance. ' +
      'Aquí el Gateway publica sus eventos de verdad en RabbitMQ para poder ver cómo reaccionan ' +
      'los dos servicios implementados.'),
  );

  const productos = await api.listarProductos({ limit: 100 }).then((r) => r.data).catch(() => []);
  const productores = await api.listarProductores({ limit: 100 }).then((r) => r.data).catch(() => []);

  raiz.append(
    el('div', { class: 'rejilla' }, panelStock(productos), panelIdentidad(productores)),
  );
}

// -------------------------------------------------------- inventory-service

function panelStock(productos) {
  const zonaResultado = el('div', {});

  const caja = el(
    'div',
    { class: 'campos' },
    campo('Producto', seleccion('product_id', [['', 'Elija…'], ...productos.map((p) => [p.id, p.name])],
      { value: estado.productoId ?? '' })),
    campo('stock_version', entrada('stock_version', { type: 'number', min: '0', value: '10' }),
      'Debe ser mayor que la última procesada'),
    campo('available_kg', entrada('available_kg', { type: 'number', step: '0.001', value: '15' }),
      'Lo que el catálogo puede ofrecer'),
    campo('physical_kg', entrada('physical_kg', { type: 'number', step: '0.001', value: '15' }), 'Opcional'),
    campo('event_id', entrada('event_id', { placeholder: 'vacío = uno nuevo' }),
      'Repita uno para probar la idempotencia'),
  );

  async function publicar() {
    const datos = valores(caja);
    if (!datos.product_id) return aviso('Falta el producto', '', 'mal');

    try {
      const antes = await api.precioVigente(datos.product_id).catch(() => null);
      const r = await api.simularStock(datos);
      aviso('Evento publicado', r.evento.event_id, 'info');

      // El consumidor es asíncrono: se consulta hasta que cambie o se agote.
      let despues = antes;
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 900));
        despues = await api.precioVigente(datos.product_id).catch(() => despues);
        if (despues && antes && (despues.price !== antes.price || despues.stock_version !== antes.stock_version)) break;
      }

      vaciar(zonaResultado).append(comparativa(antes, despues));
      const cambio = antes && despues && (antes.price !== despues.price || antes.stock_version !== despues.stock_version);
      if (cambio) aviso('El catálogo reaccionó', `Precio ${fmtDinero(despues.price)} · ${despues.reason}`);
      else aviso('Sin cambios', 'El evento se ignoró por versión antigua o duplicada', 'info');

      // Sugiere la siguiente versión para encadenar pruebas.
      caja.querySelector('[name=stock_version]').value = Number(datos.stock_version) + 1;
    } catch (err) {
      avisarError(err, 'No se pudo publicar el evento');
    }
  }

  const btn = boton('Publicar inventory.stock_changed', async () => {
    btn.disabled = true;
    btn.textContent = 'Publicando y esperando al consumidor…';
    try {
      await publicar();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Publicar inventory.stock_changed';
    }
  });

  const atajos = el(
    'div',
    { class: 'acciones' },
    boton('Stock bajo (15 kg)', () => fijar(caja, { available_kg: 15 }), 'btn btn-sutil btn-chico'),
    boton('Stock normal (50 kg)', () => fijar(caja, { available_kg: 50 }), 'btn btn-sutil btn-chico'),
    boton('Stock alto (150 kg)', () => fijar(caja, { available_kg: 150 }), 'btn btn-sutil btn-chico'),
  );

  return tarjeta(
    'Inventario (simulado)',
    el('div', {}, caja, el('div', { class: 'acciones', style: 'margin-top:14px' }, atajos), pie(btn), zonaResultado),
    {
      pista: 'Regla: por debajo del umbral bajo el precio sube un 10 %; por encima del alto baja un 10 %. ' +
        'Un stock_version menor o igual al último procesado se descarta.',
    },
  );
}

function fijar(caja, parche) {
  for (const [k, v] of Object.entries(parche)) {
    const campoEl = caja.querySelector(`[name=${k}]`);
    if (campoEl) campoEl.value = v;
  }
  const otro = caja.querySelector('[name=physical_kg]');
  if (otro && parche.available_kg !== undefined) otro.value = parche.available_kg;
}

function comparativa(antes, despues) {
  const columna = (titulo, v) =>
    el(
      'div',
      { style: 'flex:1;min-width:150px' },
      el('div', { class: 'precio-meta' }, titulo),
      el('div', { class: 'precio-grande', style: 'font-size:24px' }, v ? fmtDinero(v.price) : '—'),
      v ? el('div', { class: 'acciones' }, insignia(v.reason)) : null,
      v ? el('div', { class: 'precio-meta' }, `${fmtKg(v.available_kg)} · v${v.stock_version}`) : null,
    );

  return el(
    'div',
    { style: 'display:flex;gap:18px;align-items:center;margin-top:16px;flex-wrap:wrap' },
    columna('Antes', antes),
    el('div', { style: 'font-size:20px;color:var(--texto-suave)' }, '→'),
    columna('Después', despues),
  );
}

// --------------------------------------------------------- identity-service

function panelIdentidad(productores) {
  const zonaResultado = el('div', {});

  const caja = el(
    'div',
    { class: 'campos' },
    campo('Productor', seleccion('producer_id', [['', 'Elija…'], ...productores.map((p) => [p.id, p.full_name])])),
    campo('user_id', entrada('user_id', { value: sesion.userId ?? '', placeholder: 'UUID de la cuenta de Identidad' }),
      'Es el sub del JWT. La API de Productores no lo expone: no devuelve datos de Identidad.'),
  );

  const btn = boton('Publicar identity.user_disabled', async () => {
    const datos = valores(caja);
    if (!datos.user_id) return aviso('Falta el user_id', 'Ese es el dato que lleva el evento', 'mal');

    btn.disabled = true;
    try {
      const r = await api.simularBajaUsuario({ user_id: datos.user_id });
      aviso('Evento publicado', r.evento.event_id, 'info');

      if (datos.producer_id) {
        let p = null;
        for (let i = 0; i < 12; i++) {
          await new Promise((res) => setTimeout(res, 900));
          p = await api.verProductor(datos.producer_id).catch(() => null);
          if (p?.status === 'disabled') break;
        }
        vaciar(zonaResultado).append(
          el('div', { style: 'margin-top:14px' },
            el('div', { class: 'precio-meta' }, 'Estado del productor tras el evento'),
            el('div', { class: 'acciones' }, p ? insignia(p.status) : el('span', { class: 'insignia neutra' }, 'sin datos')),
            p?.status === 'disabled'
              ? el('p', { class: 'pista' },
                  'Productores lo deshabilitó y publicó producer.disabled; Catálogo retirará sus productos.')
              : el('p', { class: 'pista' }, 'Ese user_id no tiene perfil de productor, así que no hubo efecto.'),
          ),
        );
      }
    } catch (err) {
      avisarError(err, 'No se pudo publicar el evento');
    } finally {
      btn.disabled = false;
    }
  });

  return tarjeta(
    'Identidad (simulada)',
    el('div', {}, caja, pie(btn), zonaResultado),
    {
      pista: 'Cadena completa: identity.user_disabled → Productores lo deshabilita y publica ' +
        'producer.disabled → Catálogo retira sus productos sin borrar el historial.',
    },
  );
}
