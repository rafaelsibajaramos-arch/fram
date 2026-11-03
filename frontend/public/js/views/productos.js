// Vista de Productos: alta, filtros, precio vigente e historial de precios.

import { api, sesion } from '../api.js';
import { estado } from '../state.js';
import { campoProductor, contextoProductor, motivoSinProductor } from '../campos.js';
import {
  avisarError, aviso, boton, campo, cargando, el, entrada, fmtDinero, fmtFecha, fmtKg,
  bloqueAviso, enlaceBoton, faltanDatos, insignia, insigniaBool, pie, seleccion,
  tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaProductos(raiz) {
  raiz.append(
    el('h1', {}, 'Productos'),
    el('p', { class: 'subtitulo' },
      sesion.roles.includes('buyer') ? 'Del campo a tu mesa. Elige productos frescos y compra la cantidad que necesitas.' : 'Administra tu oferta, disponibilidad y precios por kilogramo.'),
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
              { titulo: 'Productor', celda: (p) => el('span', {}, p.producer_name ?? nombreProductor(p, ctxProductor)) },
            ],
            r.data,
            {
              alElegir: (p) => { estado.fijar({ productoId: p.id }); refrescarLista(); refrescarDetalle(); },
              elegida: (p) => p.id === estado.productoId,
              vacio: 'Sin productos que coincidan.',
            },
          )),
          {},
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

function nombreProductor(producto, contexto) {
  // Mientras termina de actualizarse una réplica asíncrona, el productor de
  // la sesión o la lista administrativa permite mostrar un nombre y nunca un
  // UUID al usuario.
  const productor = contexto.lista?.find((item) => item.id === producto.producer_id);
  return productor?.full_name ?? 'Productor sin nombre disponible';
}

async function vistaComprador(raiz) {
  const zona = el('div', {}); raiz.append(zona); zona.append(cargando());
  try {
    const r = await api.productosDisponibles({ limit: 100 }); const productos = r.data ?? r;
    const search = entrada('buscar_producto', { type: 'search', placeholder: 'Busca frutas, verduras y productos del campo', 'aria-label': 'Buscar productos' });
    const categoryNames = [...new Set(productos.map(p => p.category?.name).filter(Boolean))];
    const category = seleccion('categoria', [['', 'Todas las categorías'], ...categoryNames.map(c => [c, c])]);
    const grid = el('div', { class: 'market-grid' });
    const count = el('p', { class: 'pista', 'aria-live': 'polite' });
    const paint = () => {
      const rows = productos.filter(p => p.name.toLowerCase().includes(search.value.toLowerCase()) && (!category.value || p.category?.name === category.value));
      count.textContent = `${rows.length} productos disponibles · precios en COP por kilogramo`;
      vaciar(grid);
      if (!rows.length) grid.append(el('div', { class: 'operations-empty' }, el('strong', {}, 'No encontramos productos'), el('p', {}, 'Prueba otra búsqueda o vuelve más tarde para consultar nuevas cosechas.')));
      for (const p of rows) {
        const amount = entrada('quantity_kg', { type: 'number', min: p.min_order_quantity, max: p.available_kg, step: '0.001', value: p.min_order_quantity, 'aria-label': `Kilos de ${p.name}` });
        const add = boton('Agregar al carrito', async () => {
          add.disabled = true;
          try {
            if (!amount.checkValidity()) { amount.reportValidity(); return; }
            const quantity = Number(amount.value); if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Indica una cantidad válida');
            const actual = await api.verCarrito(sesion.userId);
            const current = actual?.items ?? [];
            const total = quantity + Number(current.find(i => i.productId === p.id)?.quantity ?? 0);
            if (total > Number(p.available_kg)) throw new Error('La cantidad del carrito supera la disponibilidad actual');
            const items = current.filter(i => i.productId !== p.id).map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice ?? 0), ...(i.priceVersionId ? { priceVersionId: i.priceVersionId } : {}) }));
            items.push({ productId: p.id, quantity: total, unitPrice: Number(p.price), ...(p.price_version_id ? { priceVersionId: p.price_version_id } : {}) });
            await api.guardarCarrito(sesion.userId, { items });
            aviso('Agregado al carrito', `${p.name} · ${fmtKg(total)} en tu carrito.`);
          } catch (error) { avisarError(error, 'No se pudo agregar el producto'); }
          finally { add.disabled = false; }
        }, 'btn btn-primario');
        grid.append(el('article', { class: 'market-card' },
          el('div', { class: 'market-card-top' }, el('span', { class: 'market-product-mark', 'aria-hidden': 'true' }, p.name.slice(0, 2).toUpperCase()), el('span', { class: 'ops-badge' }, p.category?.name ?? 'Del campo')),
          el('h2', {}, p.name), el('p', { class: 'market-producer' }, p.producer_name ?? 'Producto de origen local'),
          el('div', { class: 'market-price' }, el('strong', {}, fmtDinero(p.price)), el('small', {}, 'COP / kg')),
          p.price_reason === 'high_stock' ? el('p', { class: 'market-offer' }, 'Precio especial por alta disponibilidad') : null,
          el('p', { class: 'pista' }, `Disponible: ${fmtKg(p.available_kg)} · mínimo ${fmtKg(p.min_order_quantity)}`),
          el('div', { class: 'market-card-action' }, fieldMarket('Cantidad (kg)', amount), add)));
      }
    };
    vaciar(zona).append(el('div', { class: 'market-toolbar' }, search, category), count, grid, el('p', { class: 'pista' }, 'El precio y la disponibilidad se confirman al realizar tu compra. La entrega se coordina según tu dirección y zona.')); search.addEventListener('input', paint); category.addEventListener('change', paint); paint();
  } catch (error) {
    if (!sesion.activa) return;
    avisarError(error, 'No se pudo cargar la oferta'); vaciar(zona).append(el('p', {}, 'No pudimos cargar el catálogo. Intenta de nuevo en unos momentos.'));
  }
}
function fieldMarket(label, control) { return el('label', { class: 'operations-field' }, el('span', {}, label), control); }

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
      aviso('Producto creado', p.name);
      estado.fijar({ productoId: p.id });
      await alCrear();
    } catch (err) {
      avisarError(err, 'No se pudo crear el producto');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  return tarjeta('Nuevo producto', el('div', {}, caja, pie(btn)));
}

// ------------------------------------------------------------------ precio

function panelPrecio(p, precio) {
  if (!precio) {
    return tarjeta(p.name, el('div', { class: 'vacio' }, 'Sin precio disponible'));
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
        el('span', { class: 'insignia info' }, `Disponible ${fmtKg(precio.available_kg)}`)),
      el('div', { class: 'precio-meta', style: 'margin-top:10px' },
        'Vigente desde ', fmtFecha(precio.valid_from)),
    ),
    { accion: el('div', { class: 'acciones' }, insigniaBool(p.active)) },
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
      'Al cambiarlo, se actualizará el precio vigente.'),
    campo('Mínimo de compra', entrada('min_order_quantity', { type: 'number', step: '0.001', value: p.min_order_quantity })),
    campo('Umbral bajo', entrada('low_stock_threshold', { type: 'number', step: '0.001', value: p.low_stock_threshold })),
    campo('Umbral alto', entrada('high_stock_threshold', { type: 'number', step: '0.001', value: p.high_stock_threshold })),
  );
  const selectorCat = caja.querySelector('[name=category_id]');
  if (selectorCat) selectorCat.value = p.category?.id ?? '';

  const guardar = boton('Guardar', async () => {
    try {
      await api.actualizarProducto(p.id, valores(caja));
      aviso('Producto actualizado');
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
        aviso('Producto actualizado', p.active ? 'Ya no aparece en la oferta.' : 'Ya está disponible para comprar.');
        await refrescarLista();
        await refrescarDetalle();
      } catch (err) {
        avisarError(err, 'No se pudo cambiar el estado');
      }
    },
    p.active ? 'btn btn-peligro' : 'btn',
  );

  return tarjeta('Ajustes', el('div', {}, caja, pie(guardar, alternar)));
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
          `Disponible ${v.available_kg} kg`),
      ),
    ),
  );

  const vigentes = historial.filter((v) => v.valid_to === null).length;

  return tarjeta(`Historial de precios (${historial.length})`, linea, {
    accion: el('span', { class: `insignia ${vigentes === 1 ? 'ok' : 'mal'}` },
      `${vigentes} precio vigente`),
  });
}
