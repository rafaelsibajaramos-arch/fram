// Vista de Lotes de cosecha.

import { api } from '../api.js';
import { estado } from '../state.js';
import { campoFinca } from '../campos.js';
import {
  avisarError, aviso, boton, campo, cargando, el, entrada, fmtKg,
  faltanDatos, insignia, pie, seleccion, tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaCosechas(raiz) {
  raiz.append(
    el('h1', {}, 'Lotes de cosecha'),
    el('p', { class: 'subtitulo' },
      'Gestiona tus cosechas, su finca de origen y las fechas de disponibilidad. La cantidad corresponde a lo cosechado, no al saldo de inventario.'),
  );

  const zonaAlta = el('div', {});
  const zonaLista = el('div', {});
  raiz.append(zonaAlta, zonaLista);

  const productos = await api.listarProductos({ limit: 100 }).then((r) => r.data).catch(() => []);
  const nombresProductos = new Map(productos.map(p => [p.id, p.name]));
  const nombresFincas = new Map();
  zonaAlta.append(formularioAlta(productos, refrescar));

  const filtros = el(
    'div',
    { class: 'campos', style: 'margin-bottom:14px' },
    campo('Producto', seleccion('product_id', [['', 'Todos'], ...productos.map((p) => [p.id, p.name])],
      { onchange: () => refrescar() })),
    campo('Estado', seleccion('status',
      [['', 'Todos'], ['registered', 'Registrados'], ['published', 'Publicados'], ['closed', 'Cerrados']],
      { onchange: () => refrescar() })),
    campo('Vencen antes de', entrada('expiry_estimate', { type: 'date', onchange: () => refrescar() })),
  );

  async function refrescar() {
    vaciar(zonaLista).append(cargando());
    try {
      const r = await api.listarLotes({ ...valores(filtros), limit: 50 });
      await Promise.all([
        ...[...new Set(r.data.map(l => l.product_id))].filter(id => !nombresProductos.has(id)).map(async id => {
          try { const p = await api.verProducto(id); nombresProductos.set(id, p.name); } catch { /* conservar la lista aunque falte una referencia */ }
        }),
        ...[...new Set(r.data.map(l => l.farm_id))].filter(id => !nombresFincas.has(id)).map(async id => {
          try { const f = await api.verFinca(id); nombresFincas.set(id, f.farm_name); } catch { /* mostrar un texto claro, nunca el UUID */ }
        }),
      ]);
      vaciar(zonaLista).append(
        tarjeta(
          `Lotes (${r.meta.total})`,
          el('div', {}, filtros, tabla(
            [
              { titulo: 'Cosecha de', celda: (l) => el('strong', {}, nombresProductos.get(l.product_id) || 'Producto no disponible') },
              { titulo: 'Finca de origen', celda: (l) => nombresFincas.get(l.farm_id) || 'Finca no disponible' },
              { titulo: 'Cosecha', celda: (l) => l.harvest_date },
              { titulo: 'Vence', celda: (l) => l.expiry_estimate },
              { titulo: 'Cantidad', celda: (l) => fmtKg(l.quantity_kg), num: true },
              { titulo: 'Estado', celda: (l) => insignia(l.status) },
              { titulo: '', celda: (l) => acciones(l, refrescar) },
            ],
            r.data,
            { vacio: 'Sin lotes registrados.' },
          )),
          { pista: 'Cada fila corresponde a un lote. Identifica su origen por el nombre de la finca y su fecha de cosecha.' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudieron listar los lotes');
      vaciar(zonaLista);
    }
  }

  await refrescar();
}

function acciones(lote, refrescar) {
  const caja = el('div', { class: 'acciones' });

  if (lote.status === 'registered') {
    caja.append(
      boton('Publicar', async () => {
        try {
          await api.publicarLote(lote.batch_id);
          aviso('Lote publicado', 'Se encoló harvest.registered en el outbox');
          await refrescar();
        } catch (err) {
          avisarError(err, 'No se pudo publicar');
        }
      }, 'btn btn-chico', 'reproducir'),
    );
  }

  if (lote.status !== 'closed') {
    caja.append(
      boton('Cerrar', async () => {
        try {
          await api.cerrarLote(lote.batch_id);
          aviso('Lote cerrado', 'Deja de ser una oferta nueva, pero no se borra');
          await refrescar();
        } catch (err) {
          avisarError(err, 'No se pudo cerrar');
        }
      }, 'btn btn-sutil btn-chico', 'check'),
    );
  }

  return caja;
}

function formularioAlta(productos, alCrear) {
  const hoy = new Date().toISOString().slice(0, 10);
  const enDiezDias = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);

  const finca = campoFinca();

  // Al elegir producto se cargan las fincas de SU productor: así no se puede
  // registrar un lote con la finca de otro.
  const selProducto = seleccion('product_id', [['', 'Elija…'], ...productos.map((p) => [p.id, p.name])], {
    onchange: (e) => {
      const elegido = productos.find((p) => p.id === e.target.value);
      void finca.recargar(elegido?.producer_id);
    },
  });
  selProducto.value = estado.productoId ?? '';
  void finca.recargar(productos.find((p) => p.id === selProducto.value)?.producer_id);

  const caja = el(
    'div',
    { class: 'campos' },
    campo('Producto', selProducto),
    finca.nodo,
    campo('Fecha de cosecha', entrada('harvest_date', { type: 'date', value: hoy })),
    campo('Cantidad cosechada', entrada('quantity_kg', { type: 'number', step: '0.001', value: '100' }), 'kg, > 0'),
    campo('Vencimiento estimado', entrada('expiry_estimate', { type: 'date', value: enDiezDias }),
      '>= fecha de cosecha'),
  );

  const btn = boton('Registrar lote', async () => {
    const datos = valores(caja);
    if (faltanDatos([
      [datos.product_id, 'producto'],
      [datos.farm_id, 'finca de origen'],
      [datos.harvest_date, 'fecha de cosecha'],
      [datos.quantity_kg, 'cantidad'],
      [datos.expiry_estimate, 'vencimiento estimado'],
    ])) return;

    btn.disabled = true;
    try {
      const l = await api.crearLote(datos);
      aviso('Lote registrado', `${productos.find(p => p.id === datos.product_id)?.name || 'Producto'} · listo para publicar`);
      await alCrear();
    } catch (err) {
      avisarError(err, 'No se pudo registrar el lote');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  return tarjeta('Nuevo lote', el('div', {}, caja, pie(btn)), {
    pista: 'Antes de aceptarlo, Catálogo comprueba por REST que el producto esté activo, que la finca ' +
      'exista y esté activa, y que pertenezca al productor del producto.',
  });
}
