import { api, sesion } from '../api.js';
import { avisarError, aviso, boton, el, fmtDinero, fmtFecha, vaciar } from '../ui.js';

const estados = ['confirmed', 'dispatched', 'delivered', 'cancelled'];

export async function vistaPedidos(raiz) {
  const esAdmin = sesion.esAdmin;
  const esProductor = !esAdmin && sesion.roles.includes('producer');
  const titulo = esAdmin ? 'Todos los pedidos' : esProductor ? 'Ventas recibidas' : 'Mis pedidos';
  const descripcion = esAdmin
    ? 'Registro operativo de todas las compras confirmadas.'
    : esProductor
      ? 'Solo se muestran las líneas de productos que pertenecen a tu producción.'
      : 'Detalle, pago y seguimiento de tus compras.';
  raiz.append(el('h1', {}, titulo), el('p', { class: 'subtitulo' }, descripcion));
  const zona = el('div', {}); raiz.append(zona); zona.append(el('p', {}, 'Cargando pedidos…'));

  try {
    const orders = await api.listarPedidos();
    const partes = [];
    if (!esAdmin && !esProductor) {
      const wallet = await api.verBilletera(sesion.userId);
      partes.push(el('div', { class: 'tarjeta' }, el('h2', {}, 'TerraWallet'), el('p', {}, `Saldo disponible: ${fmtDinero(wallet?.balance ?? 0)} ${wallet?.currency ?? 'COP'}`)));
    }
    const lista = el('div', { class: 'tarjeta' }, el('h2', {}, esProductor ? 'Ventas' : 'Registro de pedidos'));
    if (!orders.length) lista.append(el('p', {}, esProductor ? 'Todavía no tienes ventas registradas.' : 'Aún no hay pedidos registrados.'));
    for (const order of orders) lista.append(tarjetaPedido(order, { esAdmin, esProductor, recargar: () => { vaciar(raiz); return vistaPedidos(raiz); } }));
    vaciar(zona).append(...partes, lista);
  } catch (error) {
    avisarError(error, 'No se pudieron cargar los pedidos');
    vaciar(zona).append(el('p', {}, 'No pudimos cargar el registro de pedidos.'));
  }
}

function tarjetaPedido(order, { esAdmin, esProductor, recargar }) {
  const lineas = el('div', { class: 'pedido-lineas' });
  for (const item of order.items ?? []) {
    const cantidad = Number(item.quantity ?? 0);
    const unitario = Number(item.unitPrice ?? 0);
    const subtotal = Number(item.subtotal ?? cantidad * unitario);
    lineas.append(el('div', { class: 'carrito-item' },
      el('strong', {}, item.productName ?? 'Producto'),
      el('span', {}, `${cantidad} kg × ${fmtDinero(unitario)} ${order.currency}`),
      el('b', {}, `${fmtDinero(subtotal)} ${order.currency}`),
    ));
  }
  const cuerpo = el('article', { class: 'bloque' },
    el('div', { class: 'acciones' },
      el('strong', {}, `Pedido ${String(order.id).slice(0, 8)} · ${String(order.status).toUpperCase()}`),
      el('span', {}, `Pago: ${order.paymentStatus}`),
    ),
    el('small', {}, fmtFecha(order.createdAt)),
    !esProductor ? el('p', {}, `Entrega: ${order.deliveryAddress}`) : null,
    lineas,
    el('strong', {}, `Total: ${fmtDinero(order.totalAmount)} ${order.currency}`),
  );
  if (esAdmin) cuerpo.append(controlEstado(order, recargar));
  return cuerpo;
}

function controlEstado(order, recargar) {
  const select = el('select', { class: 'input' });
  for (const estado of estados) select.append(el('option', { value: estado, selected: order.status === estado }, estado));
  return el('div', { class: 'acciones' }, select, boton('Actualizar estado', async () => {
    try {
      await api.actualizarPedido(order.id, select.value);
      aviso('Pedido actualizado', `Estado: ${select.value}`);
      recargar();
    } catch (error) { avisarError(error, 'No se pudo actualizar el pedido'); }
  }, 'btn btn-sutil'));
}
