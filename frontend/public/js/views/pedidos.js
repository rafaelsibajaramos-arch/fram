import { api, sesion } from '../api.js';
import { avisarError, aviso, boton, el, fmtDinero, fmtFecha, vaciar } from '../ui.js';

const estados = ['confirmed', 'dispatched', 'delivered', 'cancelled'];
const etiquetas = { confirmed: 'Confirmado', dispatched: 'En camino', delivered: 'Entregado', cancelled: 'Cancelado', pending: 'Pendiente', paid: 'Pagado', failed: 'Fallido', refunded: 'Reembolsado', completed: 'Completado' };
const etiqueta = valor => etiquetas[String(valor).toLowerCase()] ?? 'Por confirmar';

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
      partes.push(el('div', { class: 'pedido-wallet' }, el('div', {}, el('span', { class: 'pedido-eyebrow' }, 'TU BILLETERA'), el('h2', {}, 'TerraWallet')), el('div', {}, el('small', {}, 'Saldo disponible'), el('strong', {}, `${fmtDinero(wallet?.balance ?? 0)} ${wallet?.currency ?? 'COP'}`))));
    }
    const resumen = el('div', { class: 'pedidos-resumen' },
      ...[['Pedidos registrados', orders.length], ['En preparación', orders.filter(o => o.status === 'confirmed').length], ['Entregados', orders.filter(o => o.status === 'delivered').length]].map(([titulo, valor]) => el('div', {}, el('span', {}, titulo), el('strong', {}, String(valor)))));
    partes.push(resumen);
    const lista = el('div', { class: 'pedidos-lista' });
    if (!orders.length) lista.append(el('div', { class: 'pedido-vacio' }, el('h2', {}, esProductor ? 'Tus próximas ventas estarán aquí' : 'Tu historial comienza aquí'), el('p', {}, 'Aquí encontrarás el estado, los productos y los detalles de cada pedido.')));
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
  const detalle = el('div', { class: 'pedido-detalle', hidden: true },
    el('h3', {}, 'Detalle del pedido'),
    el('p', {}, `Dirección de entrega: ${order.deliveryAddress || 'No registrada'}`),
    el('p', {}, `Estado de pago: ${etiqueta(order.paymentStatus)}`),
    lineas,
    el('strong', { class: 'pedido-total-detalle' }, `${esProductor ? 'Total de tus productos' : 'Total del pedido'}: ${fmtDinero(order.totalAmount)} ${order.currency}`),
  );
  if (esAdmin) detalle.append(controlEstado(order, recargar));
  const verDetalle = boton('Ver detalles', () => {
    detalle.hidden = !detalle.hidden;
    verDetalle.textContent = detalle.hidden ? 'Ver detalles' : 'Ocultar detalles';
    verDetalle.setAttribute('aria-expanded', String(!detalle.hidden));
  }, 'btn btn-sutil');
  verDetalle.setAttribute('aria-expanded', 'false');
  const nombres = [...new Set((order.items ?? []).map(i => i.productName || 'Producto no disponible'))];
  const cuerpo = el('article', { class: 'pedido-card' },
    el('div', { class: 'pedido-cabecera' },
      el('div', {}, el('span', { class: 'pedido-eyebrow' }, esProductor ? 'VENTA RECIBIDA' : 'COMPRA REGISTRADA'),
        el('h2', {}, nombres.join(' · ') || 'Pedido'), el('small', {}, fmtFecha(order.createdAt))),
      el('span', { class: `pedido-estado ${estados.includes(order.status) ? order.status : 'pending'}` }, etiqueta(order.status)),
    ),
    el('div', { class: 'pedido-pie' }, el('div', {}, el('span', {}, esProductor ? 'Importe de tus productos' : 'Total de la compra'), el('strong', {}, `${fmtDinero(order.totalAmount)} ${order.currency ?? 'COP'}`)),
      el('small', {}, `${(order.items ?? []).length} producto(s)`), verDetalle),
    detalle,
  );
  return cuerpo;
}

function controlEstado(order, recargar) {
  const select = el('select', { class: 'input' });
  for (const estado of estados) select.append(el('option', { value: estado, selected: order.status === estado }, etiqueta(estado)));
  select.setAttribute('aria-label', 'Estado del pedido');
  return el('div', { class: 'acciones' }, select, boton('Actualizar estado', async () => {
    try {
      await api.actualizarPedido(order.id, select.value);
      aviso('Pedido actualizado', `Estado: ${select.value}`);
      recargar();
    } catch (error) { avisarError(error, 'No se pudo actualizar el pedido'); }
  }, 'btn btn-sutil'));
}
