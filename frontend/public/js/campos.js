// Campos que resuelven solos las referencias externas, para que nadie tenga
// que pegar UUIDs a mano.
//
// La API sigue exigiendo producer_id y farm_id porque son referencias a
// producer_db y el contrato no cambia; lo que cambia es de dónde los saca la
// interfaz: del perfil del usuario autenticado y de sus fincas.

import { api, sesion } from './api.js';
import { boton, campo, chipId, el, entrada, seleccion } from './ui.js';

/**
 * Resuelve el productor con el que trabaja la sesión.
 * Un productor solo puede operar el suyo; un admin elige de la lista.
 */
export async function contextoProductor() {
  if (sesion.esAdmin) {
    const r = await api.listarProductores({ status: 'active', limit: 100 }).catch(() => ({ data: [] }));
    const lista = r.data ?? [];
    return { esAdmin: true, propio: null, lista, listo: lista.length > 0 };
  }

  const propio = await api.productorPorUsuario(sesion.userId).catch(() => null);
  return { esAdmin: false, propio, lista: propio ? [propio] : [], listo: !!propio };
}

/** Motivo por el que no se puede publicar todavía, o null si todo está listo. */
export function motivoSinProductor(ctx) {
  if (ctx.listo) return null;
  return ctx.esAdmin
    ? {
        titulo: 'No hay productores activos',
        texto:
          'Para publicar en el catálogo hace falta al menos un productor activo. ' +
          'Créelo en la sección Productores.',
      }
    : {
        titulo: 'Su cuenta aún no tiene perfil de productor',
        texto:
          'El catálogo exige un producer_id existente y activo, y lo valida por REST contra ' +
          'Productores. Cree primero su perfil y vuelva aquí.',
      };
}

/**
 * Campo de productor. Devuelve { nodo, valor(), listo }.
 * - productor: muestra su perfil, fijo y no editable.
 * - admin: selector con los productores activos.
 */
export function campoProductor(ctx, { alCambiar } = {}) {
  if (ctx.esAdmin) {
    const sel = seleccion(
      'producer_id',
      [['', 'Elija un productor…'], ...ctx.lista.map((p) => [p.id, `${p.full_name} · ${p.email}`])],
      alCambiar ? { onchange: (e) => alCambiar(e.target.value) } : {},
    );
    return {
      nodo: campo('Productor', sel, 'Como administrador puede publicar en nombre de cualquiera'),
      valor: () => sel.value || undefined,
      listo: ctx.listo,
    };
  }

  const oculto = entrada('producer_id', { type: 'hidden', value: ctx.propio?.id ?? '' });

  return {
    nodo: campo(
      'Productor',
      el(
        'div',
        { class: 'acciones', style: 'min-height:32px' },
        oculto,
        ctx.propio
          ? el('span', { class: 'insignia ok sin-punto' }, ctx.propio.full_name)
          : el('span', { class: 'insignia mal sin-punto' }, 'Sin perfil'),
        ctx.propio ? chipId(ctx.propio.id) : null,
      ),
      'Se toma de su perfil; Catálogo lo valida por REST contra Productores',
    ),
    valor: () => ctx.propio?.id,
    listo: ctx.listo,
  };
}

/**
 * Campo de finca. Se rellena con las fincas activas del productor indicado.
 * Devuelve { nodo, valor(), recargar(producerId) }.
 */
export function campoFinca(producerIdInicial) {
  const sel = seleccion('farm_id', [['', 'Elija primero un producto']]);
  const ayuda = el('small', {}, 'Debe pertenecer al productor del producto');
  let turno = 0, contexto = null;
  const vincular = boton('Vincular otra finca', () => {
    if (contexto) void recargar(contexto.producerId, contexto.productId, true);
  }, 'btn btn-sutil btn-chico');
  vincular.hidden = true;
  const nodo = el('div', { class: 'campo' }, el('label', {}, 'Finca de origen'), sel, ayuda, vincular);

  async function recargar(producerId, productId, mostrarTodas = false) {
    const actual = ++turno;
    contexto = { producerId, productId };
    sel.disabled = true;
    vincular.hidden = true;
    if (!producerId) {
      sel.replaceChildren(el('option', { value: '' }, 'Elija primero un producto'));
      ayuda.textContent = 'Debe pertenecer al productor del producto';
      return;
    }

    sel.replaceChildren(el('option', { value: '' }, 'Cargando…'));
    let fincas, lotes = [];
    try {
      [fincas, lotes] = await Promise.all([
        api.listarFincas(producerId, { active: true }),
        productId && !mostrarTodas ? lotesDelProducto(productId) : Promise.resolve([]),
      ]);
    } catch {
      if (actual !== turno) return;
      sel.replaceChildren(el('option', { value: '' }, 'No se pudieron cargar las fincas'));
      ayuda.textContent = 'Vuelve a seleccionar el producto para reintentar.';
      return;
    }
    if (actual !== turno) return;
    const disponibles = fincas;
    if (productId && !mostrarTodas) {
      const vinculadas = new Set(lotes.map(lote => lote.farm_id));
      fincas = fincas.filter(finca => vinculadas.has(finca.id));
      vincular.hidden = !disponibles.some(finca => !vinculadas.has(finca.id));
    }

    if (!fincas.length) {
      sel.replaceChildren(el('option', { value: '' }, disponibles.length ? 'Este producto aún no tiene fincas vinculadas' : 'Ese productor no tiene fincas activas'));
      ayuda.textContent = disponibles.length ? 'Vincula una finca al registrar el primer lote de este producto.' : 'Cree una finca en la sección Productores';
      return;
    }

    sel.replaceChildren(
      el('option', { value: '' }, 'Elija una finca…'),
      ...fincas.map((f) => el('option', { value: f.id }, `${f.farm_name} · ${f.address}`)),
    );
    sel.disabled = false;
    ayuda.textContent = productId && !mostrarTodas
      ? `${fincas.length} finca(s) vinculada(s) al producto seleccionado`
      : mostrarTodas ? 'Al registrar el lote, esta finca quedará vinculada al producto.' : `${fincas.length} finca(s) activa(s) de ese productor`;
  }

  if (producerIdInicial) void recargar(producerIdInicial);

  return { nodo, valor: () => sel.value || undefined, recargar };
}

async function lotesDelProducto(productId) {
  const lotes = [];
  for (let page = 1; ; page++) {
    const respuesta = await api.listarLotes({ product_id: productId, limit: 100, page });
    lotes.push(...respuesta.data);
    if (page >= (respuesta.meta?.pages ?? Math.ceil((respuesta.meta?.total ?? lotes.length) / 100))) return lotes;
  }
}
