// Vista de Productos: alta, filtros, precio vigente e historial de precios.

import { api, sesion } from '../api.js';
import { estado } from '../state.js';
import { campoProductor, contextoProductor, motivoSinProductor } from '../campos.js';
import {
  avisarError, aviso, boton, campo, cargando, chipId, el, entrada, fmtDinero, fmtFecha, fmtKg,
  bloqueAviso, enlaceBoton, faltanDatos, insignia, insigniaBool, pie, seleccion,
  tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaProductos(raiz) {
  raiz.append(
    el('h1', {}, 'Productos'),
    el('p', { class: 'subtitulo' },
      'Todo se vende en kg. El producto no guarda el precio vigente: la autoridad es el historial ' +
      'de precios, donde la versión actual es la que tiene valid_to = null.'),
  );

  if (sesion.roles.includes('buyer')) {
    return vistaComprador(raiz);
  }

  const zonaAlta = el('div', {});
  const zonaLista = el('div', {});
  const zonaDetalle = el('div', {});
  raiz.append(zonaAlta, zonaLista, zonaDetalle);

  const categorias = await api.listarCategorias().catch(() => []);
  const ctxProductor = await contextoProductor();
  zonaAlta.append(formularioAlta(categorias, ctxProductor, refrescarLista));

  const filtros = el(
    'div',
    { class: 'campos', style: 'margin-bottom:14px' },
    campo('Categoría', seleccion('category_id', [['', 'Todas'], ...categorias.map((c) => [c.id, c.name])],
      { onchange: () => refrescarLista() })),
    campo('Estado', seleccion('active', [['', 'Todos'], ['true', 'Activos'], ['false', 'Inactivos']],
      { onchange: () => refrescarLista() })),
    campo('Disponibilidad', seleccion('available', [['', 'Toda'], ['true', 'Con stock'], ['false', 'Sin stock']],
      { onchange: () => refrescarLista() })),
    campo('Nombre', entrada('name', { placeholder: 'tomate', onkeydown: (e) => e.key === 'Enter' && refrescarLista() })),
    campo('Precio mín.', entrada('min_price', { type: 'number', min: '0', onchange: () => refrescarLista() })),
    campo('Precio máx.', entrada('max_price', { type: 'number', min: '0', onchange: () => refrescarLista() })),
  );

  async function refrescarLista() {
    vaciar(zonaLista).append(cargando());
    try {
      const r = await api.listarProductos({ ...valores(filtros), limit: 50 });
      vaciar(zonaLista).append(
        tarjeta(
          `Catálogo (${r.meta.total})`,
          el('div', {}, filtros, tabla(
            [
              { titulo: 'Producto', celda: (p) => p.name },
              { titulo: 'Categoría', celda: (p) => p.category?.name ?? '—' },
              { titulo: 'Precio', celda: (p) => fmtDinero(p.price), num: true },
              { titulo: 'Base', celda: (p) => fmtDinero(p.base_price), num: true },
              { titulo: 'Disponible', celda: (p) => fmtKg(p.available_kg), num: true },
              { titulo: 'Mín. compra', celda: (p) => fmtKg(p.min_order_quantity), num: true },
              { titulo: 'Estado', celda: (p) => insigniaBool(p.active) },
              { titulo: 'Productor', celda: (p) => chipId(p.producer_id) },
            ],
            r.data,
            {
              alElegir: (p) => { estado.fijar({ productoId: p.id }); refrescarLista(); refrescarDetalle(); },
              elegida: (p) => p.id === estado.productoId,
              vacio: 'Sin productos que coincidan.',
            },
          )),
          { pista: 'Pulse una fila para ver su precio vigente y el historial completo.' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudo listar el catálogo');
      vaciar(zonaLista);
    }
  }

  async function refrescarDetalle() {
    vaciar(zonaDetalle);
    if (!estado.productoId) return;
    vaciar(zonaDetalle).append(cargando('Cargando producto…'));
    try {
      const [p, precio, historial] = await Promise.all([
        api.verProducto(estado.productoId),
        api.precioVigente(estado.productoId).catch(() => null),
        api.historialPrecios(estado.productoId).catch(() => []),
      ]);
      vaciar(zonaDetalle).append(
        el('div', { class: 'rejilla' }, panelPrecio(p, precio), panelAjustes(p, categorias, refrescarLista, refrescarDetalle)),
        panelHistorial(historial),
      );
    } catch (err) {
      avisarError(err, 'No se pudo abrir el producto');
      estado.fijar({ productoId: null });
      vaciar(zonaDetalle);
    }
  }

  await refrescarLista();
  await refrescarDetalle();
}

async function vistaComprador(raiz) {
  const zona = el('div', {}); raiz.append(zona); zona.append(cargando());
  try {
    const r = await api.productosDisponibles({ limit: 50 }); const productos = r.data ?? r;
    vaciar(zona).append(tarjeta('Oferta disponible', tabla([
      { titulo: 'Producto', celda: (p) => p.name },
      {
        titulo: 'Precio aplicado',
        celda: (p) => el('div', {}, el('strong', {}, fmtDinero(p.price)), el('small', { class: 'precio-meta' }, `Base: ${fmtDinero(p.base_price)} / kg`)),
        num: true,
      },
      {
        titulo: 'Regla dinámica',
        celda: (p) => {
          const motivo = p.price_reason ?? p.reason ?? 'initial';
          const texto = motivo === 'high_stock'
            ? '10 % de descuento por alta disponibilidad'
            : motivo === 'low_stock'
              ? '10 % adicional por disponibilidad baja'
              : motivo === 'normal_stock'
                ? 'Precio base por disponibilidad normal'
                : 'Precio inicial; se ajusta al actualizar inventario';
          return el('div', {}, insignia(motivo), el('small', { class: 'precio-meta' }, texto));
        },
      },
      { titulo: 'Disponible', celda: (p) => fmtKg(p.available_kg), num: true },
      { titulo: 'Mínimo', celda: (p) => fmtKg(p.min_order_quantity), num: true },
      { titulo: '', celda: (p) => {
        const cantidad = entrada('quantity_kg', { type: 'number', min: p.min_order_quantity, step: '0.001', value: p.min_order_quantity, style: 'width:92px' });
        return el('div', { class: 'acciones' }, cantidad, boton('Reservar', async () => {
          try { const reserva = await api.reservarInventario({ product_id: p.id, quantity_kg: Number(cantidad.value) }); aviso('Reserva creada', `Vence a las ${new Date(reserva.reservation.expires_at).toLocaleTimeString()}`); }
          catch (error) { avisarError(error, 'No se pudo reservar el inventario'); }
        }, 'btn btn-chico'));
      } },
    ], productos, { vacio: 'No hay productos disponibles actualmente.' }), { pista: 'El precio cambia automáticamente con el stock: bajo +10 %, normal = precio base, alto −10 %. La reserva descuenta inventario real durante 15 minutos y evita sobreventa.' }));
  } catch (error) { avisarError(error, 'No se pudo cargar la oferta'); vaciar(zona); }
}

// -------------------------------------------------------------------- alta

function formularioAlta(categorias, ctxProductor, alCrear) {
  // Sin productor activo no hay nada que publicar: se explica el paso que falta
  // en lugar de dejar que el microservicio responda 422.
  const motivo = motivoSinProductor(ctxProductor);
  if (motivo) {
    return tarjeta(
      'Nuevo producto',
      bloqueAviso(motivo.titulo, motivo.texto,
        enlaceBoton('Ir a Productores', '#/productores', 'btn', 'productores')),
    );
  }

  if (!categorias.length) {
    return tarjeta(
      'Nuevo producto',
      bloqueAviso(
        'Todavía no hay categorías',
        'Cada producto pertenece a una categoría, así que debe crear al menos una.',
        enlaceBoton('Ir a Categorías', '#/categorias', 'btn', 'categorias'),
      ),
    );
  }

  const productor = campoProductor(ctxProductor);

  const caja = el(
    'div',
    { class: 'campos' },
    productor.nodo,
    campo('Nombre', entrada('name', { placeholder: 'Tomate' })),
    campo('Categoría', seleccion('category_id', [['', 'Elija…'], ...categorias.map((c) => [c.id, c.name])])),
    campo('Unidad', entrada('unit', { value: 'kg', readOnly: true }), 'Siempre kg en este alcance'),
    campo('Mínimo de compra', entrada('min_order_quantity', { type: 'number', step: '0.001', value: '5' }), '> 0'),
    campo('Precio base', entrada('base_price', { type: 'number', step: '0.01', value: '5000' }), '> 0'),
    campo('Umbral bajo', entrada('low_stock_threshold', { type: 'number', step: '0.001', value: '20' }), '>= 0'),
    campo('Umbral alto', entrada('high_stock_threshold', { type: 'number', step: '0.001', value: '100' }),
      'Debe ser mayor que el bajo'),
  );

  const btn = boton('Crear producto', async () => {
    const datos = valores(caja);
    if (faltanDatos([
      [datos.producer_id, 'productor'],
      [datos.name, 'nombre'],
      [datos.category_id, 'categoría'],
      [datos.min_order_quantity, 'mínimo de compra'],
      [datos.base_price, 'precio base'],
      [datos.low_stock_threshold, 'umbral bajo'],
      [datos.high_stock_threshold, 'umbral alto'],
    ])) return;

    btn.disabled = true;
    try {
      const p = await api.crearProducto(datos);
      aviso('Producto creado', `${p.name} · primera versión de precio (initial)`);
      estado.fijar({ productoId: p.id });
      await alCrear();
    } catch (err) {
      avisarError(err, 'No se pudo crear el producto');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  return tarjeta('Nuevo producto', el('div', {}, caja, pie(btn)), {
    pista: 'El producto y su primera versión de precio se crean en la misma transacción.',
  });
}

// ------------------------------------------------------------------ precio

function panelPrecio(p, precio) {
  if (!precio) {
    return tarjeta(p.name, el('div', { class: 'vacio' }, 'Sin versión de precio vigente'));
  }

  return tarjeta(
    p.name,
    el(
      'div',
      {},
      el('div', { class: 'precio-grande' }, fmtDinero(precio.price), el('span', { class: 'precio-unidad' }, ' / kg')),
      el('div', { class: 'precio-meta' },
        'Base ', fmtDinero(p.base_price), ' · umbrales ', fmtKg(p.low_stock_threshold), ' / ', fmtKg(p.high_stock_threshold)),
      el('div', { class: 'acciones', style: 'margin-top:14px' },
        insignia(precio.reason),
        el('span', { class: 'insignia neutra' }, `Versión de stock ${precio.stock_version}`),
        el('span', { class: 'insignia info' }, `Disponible ${fmtKg(precio.available_kg)}`)),
      el('div', { class: 'precio-meta', style: 'margin-top:10px' },
        'Vigente desde ', fmtFecha(precio.valid_from)),
      el('div', { class: 'precio-meta' },
        'price_version_id ', el('span', { class: 'mono' }, precio.price_version_id)),
      el('p', { class: 'pista', style: 'margin-top:12px' },
        'Pedidos debe conservar este price_version_id como el precio que aceptó el comprador.'),
    ),
    { accion: el('div', { class: 'acciones' }, insigniaBool(p.active), chipId(p.id)) },
  );
}

// ----------------------------------------------------------------- ajustes

function panelAjustes(p, categorias, refrescarLista, refrescarDetalle) {
  const caja = el(
    'div',
    { class: 'campos' },
    campo('Nombre', entrada('name', { value: p.name })),
    campo('Categoría', seleccion('category_id', categorias.map((c) => [c.id, c.name]), { value: p.category_id })),
    campo('Precio base', entrada('base_price', { type: 'number', step: '0.01', value: p.base_price }),
      'Cambiarlo abre una versión nueva (base_change)'),
    campo('Mínimo de compra', entrada('min_order_quantity', { type: 'number', step: '0.001', value: p.min_order_quantity })),
    campo('Umbral bajo', entrada('low_stock_threshold', { type: 'number', step: '0.001', value: p.low_stock_threshold })),
    campo('Umbral alto', entrada('high_stock_threshold', { type: 'number', step: '0.001', value: p.high_stock_threshold })),
  );
  const selectorCat = caja.querySelector('[name=category_id]');
  if (selectorCat) selectorCat.value = p.category?.id ?? '';

  const guardar = boton('Guardar', async () => {
    try {
      await api.actualizarProducto(p.id, valores(caja));
      aviso('Producto actualizado', 'Si cambió el precio base se creó una versión nueva');
      await refrescarLista();
      await refrescarDetalle();
    } catch (err) {
      avisarError(err, 'No se pudo actualizar');
    }
  }, 'btn btn-sec');

  const alternar = boton(
    p.active ? 'Retirar de la oferta' : 'Publicar de nuevo',
    async () => {
      try {
        p.active ? await api.deshabilitarProducto(p.id) : await api.habilitarProducto(p.id);
        aviso('Producto actualizado', p.active ? 'Se publicó product.unavailable' : 'Se publicó product.available');
        await refrescarLista();
        await refrescarDetalle();
      } catch (err) {
        avisarError(err, 'No se pudo cambiar el estado');
      }
    },
    p.active ? 'btn btn-peligro' : 'btn',
  );

  return tarjeta('Ajustes', el('div', {}, caja, pie(guardar, alternar)), {
    pista: p.producer_status
      ? `Estado del productor según la copia local: ${p.producer_status}`
      : 'El catálogo aún no ha recibido eventos de este productor.',
  });
}

// ---------------------------------------------------------------- historial

function panelHistorial(historial) {
  if (!historial.length) return tarjeta('Historial de precios', el('div', { class: 'vacio' }, 'Sin versiones'));

  const linea = el(
    'div',
    { class: 'linea-tiempo' },
    historial.map((v) =>
      el(
        'div',
        { class: `hito ${v.valid_to === null ? 'vigente' : ''}` },
        el('div', { class: 'hito-precio' }, fmtDinero(v.price), ' / kg  ', insignia(v.reason),
          v.valid_to === null ? el('span', { class: 'insignia ok' }, 'vigente') : null),
        el('div', { class: 'hito-meta' },
          `${fmtFecha(v.valid_from)}  →  ${v.valid_to ? fmtFecha(v.valid_to) : 'ahora'}`),
        el('div', { class: 'hito-meta' },
          `disponible ${v.available_kg} kg · stock_version ${v.stock_version}`),
      ),
    ),
  );

  const vigentes = historial.filter((v) => v.valid_to === null).length;

  return tarjeta(`Historial de precios (${historial.length})`, linea, {
    accion: el('span', { class: `insignia ${vigentes === 1 ? 'ok' : 'mal'}` },
      `${vigentes} versión vigente`),
    pista: 'Ordenado por valid_from descendente. El valid_to de cada versión coincide exactamente con ' +
      'el valid_from de la siguiente: ni huecos ni solapamientos.',
  });
}
