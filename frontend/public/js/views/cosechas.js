// Vista de Lotes de cosecha.

import { api } from '../api.js';
import { estado } from '../state.js';
import { campoFinca } from '../campos.js';
import {
  avisarError, aviso, boton, campo, cargando, chipId, el, entrada, fmtKg,
  faltanDatos, insignia, pie, seleccion, tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaCosechas(raiz) {
  raiz.append(
    el('h1', {}, 'Lotes de cosecha'),
    el('p', { class: 'subtitulo' },
      'La cantidad del lote es lo cosechado, no el saldo de inventario. Al publicarlo se emite ' +
      'harvest.registered, que es lo que consume el microservicio de Inventario.'),
  );

  const zonaAlta = el('div', {});
  const zonaLista = el('div', {});
  raiz.append(zonaAlta, zonaLista);

  const productos = await api.listarProductos({ limit: 100 }).then((r) => r.data).catch(() => []);
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
      vaciar(zonaLista).append(
        tarjeta(
          `Lotes (${r.meta.total})`,
          el('div', {}, filtros, tabla(
            [
              { titulo: 'Lote', celda: (l) => chipId(l.batch_id) },
              { titulo: 'Producto', celda: (l) => chipId(l.product_id) },
              { titulo: 'Finca', celda: (l) => chipId(l.farm_id) },
              { titulo: 'Cosecha', celda: (l) => l.harvest_date },
              { titulo: 'Vence', celda: (l) => l.expiry_estimate },
              { titulo: 'Cantidad', celda: (l) => fmtKg(l.quantity_kg), num: true },
              { titulo: 'Estado', celda: (l) => insignia(l.status) },
              { titulo: '', celda: (l) => acciones(l, refrescar) },
            ],
            r.data,
            { vacio: 'Sin lotes registrados.' },
          )),
          { pista: 'La dirección de la finca no se copia al catálogo: solo se guarda su id.' },
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
      aviso('Lote registrado', `${l.batch_id} · queda en estado registered`);
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
