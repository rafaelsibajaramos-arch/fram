// Flujo guiado: recorre de punta a punta el recorrido descrito en la
// especificación, mostrando cada llamada y su respuesta.

import { api, sesion } from '../api.js';
import { estado } from '../state.js';
import { avisarError, aviso, boton, el, tarjeta, vaciar } from '../ui.js';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export async function vistaFlujo(raiz) {
  raiz.append(
    el('h1', {}, 'Flujo guiado'),
    el('p', { class: 'subtitulo' },
      'Ejecuta el recorrido completo de la especificación sobre los dos microservicios reales: ' +
      'crear productor y finca, publicar un producto, registrar y publicar una cosecha, recibir el ' +
      'stock de Inventario por RabbitMQ y ver el precio cambiar solo. Cada paso muestra la petición ' +
      'y la respuesta tal cual.'),
  );

  const zonaPasos = el('div', {});
  const ctx = {};

  const pasos = definirPasos(ctx);
  const nodos = pasos.map((p, i) => nodoPaso(i + 1, p));

  const btnCorrer = boton('Ejecutar flujo completo', async () => {
    btnCorrer.disabled = true;
    btnLimpiar.disabled = true;
    for (const n of nodos) n.reiniciar();
    for (const k of Object.keys(ctx)) delete ctx[k];

    try {
      for (let i = 0; i < pasos.length; i++) {
        const ok = await nodos[i].ejecutar();
        if (!ok) {
          aviso('Flujo detenido', `Falló el paso ${i + 1}`, 'mal', 6000);
          return;
        }
      }
      aviso('Flujo completo', 'Los doce pasos terminaron correctamente');
    } finally {
      btnCorrer.disabled = false;
      btnLimpiar.disabled = false;
    }
  }, 'btn', 'reproducir');

  const btnLimpiar = boton('Reiniciar', () => {
    for (const n of nodos) n.reiniciar();
    for (const k of Object.keys(ctx)) delete ctx[k];
  }, 'btn btn-sutil', 'reiniciar');

  raiz.append(
    tarjeta(
      'Recorrido',
      el('div', {},
        el('div', { class: 'acciones', style: 'margin-bottom:18px' }, btnCorrer, btnLimpiar),
        zonaPasos),
      { pista: 'Crea datos reales en las dos bases de Neon. Al final puede borrarlos desde las otras vistas.' },
    ),
  );

  zonaPasos.append(...nodos.map((n) => n.nodo));
}

// ---------------------------------------------------------------- los pasos

function definirPasos(ctx) {
  return [
    {
      titulo: 'Identidad emite el JWT',
      ruta: 'POST /auth/login',
      nota: 'Estos servicios no emiten tokens ni guardan contraseñas: solo verifican el que emite Identidad.',
      correr: async () => {
        const r = await api.login('producer');
        sesion.guardar(r);
        ctx.userId = r.user_id;
        return { peticion: { role: 'producer' }, respuesta: { user_id: r.user_id, roles: r.roles, token: `${r.token.slice(0, 24)}…` } };
      },
    },
    {
      titulo: 'Crear el perfil del productor',
      ruta: 'POST /producers',
      nota: 'En la misma transacción se guarda el productor y el evento producer.created en el outbox.',
      correr: async () => {
        const cuerpo = {
          user_id: ctx.userId,
          full_name: 'Productor de la demostración',
          email: `demo-${Date.now()}@example.com`,
          phone: '3001234567',
        };
        const r = await api.crearProductor(cuerpo);
        ctx.producerId = r.id;
        estado.fijar({ productorId: r.id });
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Registrar una finca',
      ruta: 'POST /producers/:id/farms',
      nota: 'Las coordenadas se validan en el DTO y también con un CHECK en PostgreSQL.',
      correr: async () => {
        const cuerpo = {
          farm_name: 'Finca La Esperanza',
          address: 'Vereda El Rosario',
          latitude: 8.757,
          longitude: -75.89,
        };
        const r = await api.crearFinca(ctx.producerId, cuerpo);
        ctx.farmId = r.id;
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Añadir una certificación',
      ruta: 'POST /producers/:id/certifications',
      nota: 'Pertenece al productor, no a la finca. Se exige valid_until >= issue_date.',
      correr: async () => {
        const cuerpo = { type: 'Orgánica', issue_date: '2026-01-10', valid_until: '2027-01-10' };
        const r = await api.crearCertificacion(ctx.producerId, cuerpo);
        ctx.certId = r.id;
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Crear la categoría en el catálogo',
      ruta: 'POST /categories',
      nota: 'El nombre es único; repetirlo devuelve 409 Conflict.',
      correr: async () => {
        const cuerpo = { name: `Hortalizas ${new Date().toLocaleTimeString('es-CO')}` };
        const r = await api.crearCategoria(cuerpo);
        ctx.categoryId = r.id;
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Publicar el producto',
      ruta: 'POST /products',
      nota: 'Catálogo llama por REST a /internal/producers/:id/validate de Productores. Nunca consulta producer_db. ' +
        'Se crea el producto y su primera versión de precio en una sola transacción.',
      correr: async () => {
        const cuerpo = {
          producer_id: ctx.producerId,
          name: 'Tomate chonto',
          category_id: ctx.categoryId,
          unit: 'kg',
          min_order_quantity: 5,
          base_price: 5000,
          low_stock_threshold: 20,
          high_stock_threshold: 100,
        };
        const r = await api.crearProducto(cuerpo);
        ctx.productId = r.id;
        estado.fijar({ productoId: r.id });
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Registrar el lote de cosecha',
      ruta: 'POST /harvest-batches',
      nota: 'Se valida por REST que la finca exista, esté activa y pertenezca al productor del producto.',
      correr: async () => {
        const hoy = new Date().toISOString().slice(0, 10);
        const cuerpo = {
          product_id: ctx.productId,
          farm_id: ctx.farmId,
          harvest_date: hoy,
          quantity_kg: 100,
          expiry_estimate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10),
        };
        const r = await api.crearLote(cuerpo);
        ctx.batchId = r.batch_id;
        return { peticion: cuerpo, respuesta: r };
      },
    },
    {
      titulo: 'Publicar el lote',
      ruta: 'PATCH /harvest-batches/:id/publish',
      nota: 'Encola harvest.registered. El worker del outbox lo publica en RabbitMQ; Inventario lo consume.',
      correr: async () => {
        const r = await api.publicarLote(ctx.batchId);
        return { peticion: {}, respuesta: r };
      },
    },
    {
      titulo: 'Inventario informa stock bajo',
      ruta: 'inventory.stock_changed → RabbitMQ',
      nota: '15 kg está por debajo del umbral bajo (20), así que el precio debe subir un 10 %: 5000 → 5500.',
      correr: async () => {
        const antes = await api.precioVigente(ctx.productId);
        const cuerpo = { product_id: ctx.productId, stock_version: 10, available_kg: 15, physical_kg: 15 };
        await api.simularStock(cuerpo);
        const despues = await esperarPrecio(ctx.productId, (p) => p.stock_version === 10);
        ctx.precioBajo = despues?.price;
        return {
          peticion: cuerpo,
          respuesta: { antes: resumen(antes), despues: resumen(despues) },
          exito: despues?.price === 5500,
        };
      },
    },
    {
      titulo: 'Un evento antiguo no puede retroceder el catálogo',
      ruta: 'inventory.stock_changed (stock_version 5)',
      nota: 'Llega tarde y con 500 kg. Como 5 <= 10, el consumidor lo descarta: el precio no se mueve.',
      correr: async () => {
        const cuerpo = { product_id: ctx.productId, stock_version: 5, available_kg: 500, physical_kg: 500 };
        await api.simularStock(cuerpo);
        await dormir(5000);
        const ahora = await api.precioVigente(ctx.productId);
        return {
          peticion: cuerpo,
          respuesta: { precio_actual: resumen(ahora), ignorado: ahora.stock_version === 10 },
          exito: ahora.stock_version === 10 && ahora.price === ctx.precioBajo,
        };
      },
    },
    {
      titulo: 'El producto aparece como disponible',
      ruta: 'GET /products/available',
      nota: 'La disponibilidad viene de Inventario. El catálogo nunca se inventa stock.',
      correr: async () => {
        const r = await api.productosDisponibles({ producer_id: ctx.producerId });
        const ids = (r.data ?? []).map((p) => p.id);
        return {
          peticion: { producer_id: ctx.producerId },
          respuesta: { total: r.meta.total, incluye_el_producto: ids.includes(ctx.productId) },
          exito: ids.includes(ctx.productId),
        };
      },
    },
    {
      titulo: 'Dar de baja al productor lo retira de la oferta',
      ruta: 'PATCH /producers/:id/disable → producer.disabled',
      nota: 'Productores publica el evento, Catálogo lo consume y desactiva sus productos. ' +
        'Nada se borra: el historial de precios y los lotes siguen ahí.',
      correr: async () => {
        await api.deshabilitarProductor(ctx.producerId);

        let producto = null;
        for (let i = 0; i < 20; i++) {
          await dormir(1200);
          producto = await api.verProducto(ctx.productId).catch(() => producto);
          if (producto?.active === false) break;
        }

        const historial = await api.historialPrecios(ctx.productId);
        const lote = await api.verLote(ctx.batchId);

        return {
          peticion: {},
          respuesta: {
            producto_activo: producto?.active,
            productor_segun_catalogo: producto?.producer_status,
            versiones_de_precio_conservadas: historial.length,
            lote_conservado: lote.status,
          },
          exito: producto?.active === false && historial.length >= 1,
        };
      },
    },
  ];
}

function resumen(p) {
  if (!p) return null;
  return { price: p.price, reason: p.reason, available_kg: p.available_kg, stock_version: p.stock_version };
}

async function esperarPrecio(productId, condicion, intentos = 20) {
  let ultimo = null;
  for (let i = 0; i < intentos; i++) {
    await dormir(1100);
    ultimo = await api.precioVigente(productId).catch(() => ultimo);
    if (ultimo && condicion(ultimo)) return ultimo;
  }
  return ultimo;
}

// -------------------------------------------------------------- nodo visual

function nodoPaso(numero, paso) {
  const num = el('div', { class: 'paso-num' }, String(numero));
  const cuerpo = el('div', { class: 'paso-cuerpo' }, el('p', { class: 'paso-nota' }, paso.nota));
  const nodo = el(
    'div',
    { class: 'paso' },
    el('div', { class: 'paso-cabecera' }, num, el('div', { class: 'paso-titulo' }, paso.titulo),
      el('span', { class: 'paso-ruta' }, paso.ruta)),
    cuerpo,
  );

  function reiniciar() {
    nodo.className = 'paso';
    num.textContent = String(numero);
    vaciar(cuerpo).append(el('p', { class: 'paso-nota' }, paso.nota));
  }

  async function ejecutar() {
    num.textContent = String(numero);
    nodo.className = 'paso corriendo';
    try {
      const r = await paso.correr();
      const exito = r.exito !== false;
      nodo.className = `paso ${exito ? 'hecho' : 'fallo'}`;
      num.textContent = exito ? '✓' : '×';
      vaciar(cuerpo).append(
        el('p', { class: 'paso-nota' }, paso.nota),
        r.peticion && Object.keys(r.peticion).length
          ? el('div', { class: 'bloque-json' }, el('div', { class: 'bloque-etiqueta' }, 'Petición'),
              el('pre', {}, JSON.stringify(r.peticion, null, 2)))
          : null,
        el('div', { class: 'bloque-json' }, el('div', { class: 'bloque-etiqueta' }, 'Respuesta'),
          el('pre', {}, JSON.stringify(r.respuesta, null, 2))),
      );
      return exito;
    } catch (err) {
      nodo.className = 'paso fallo';
      num.textContent = '×';
      vaciar(cuerpo).append(
        el('p', { class: 'paso-nota' }, paso.nota),
        el('div', { class: 'bloque-json' }, el('div', { class: 'bloque-etiqueta' }, 'Error'),
          el('pre', {}, JSON.stringify({ error: err.message, status: err.status, cuerpo: err.cuerpo }, null, 2))),
      );
      avisarError(err, `Paso ${numero}`);
      return false;
    }
  }

  return { nodo, ejecutar, reiniciar };
}
