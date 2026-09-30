import { api, sesion } from '../api.js';
import { avisarError, el, fmtDinero, fmtFecha, vaciar } from '../ui.js';

export async function vistaPedidos(raiz) {
  raiz.append(el('h1', {}, 'Mis pedidos'), el('p', { class: 'subtitulo' }, 'Abre el carrito para revisar y confirmar tu compra.'));
  const zona = el('div', {}); raiz.append(zona); vaciar(zona).append(el('p', {}, 'Cargando historial…'));
  try {
    const [orders, wallet] = await Promise.all([api.listarPedidos(sesion.userId), api.verBilletera(sesion.userId)]);
    const saldo = el('div', { class: 'tarjeta' }, el('h2', {}, 'Billetera'), el('p', {}, `Saldo disponible: ${fmtDinero(wallet?.balance ?? 0)} ${wallet?.currency ?? 'COP'}`));
    const lista = el('div', { class: 'tarjeta' }, el('h2', {}, 'Historial'));
    if (!orders.length) lista.append(el('p', {}, 'Aún no tienes pedidos.'));
    for (const order of orders) lista.append(el('article', { class: 'bloque' }, el('strong', {}, `${order.status} · ${fmtDinero(order.totalAmount)} ${order.currency}`), el('small', {}, ` ${fmtFecha(order.createdAt)}`), el('p', {}, `${order.items?.length ?? 0} productos · ${order.deliveryAddress}`)));
    vaciar(zona).append(saldo, lista);
  } catch (error) { avisarError(error, 'No se pudieron cargar los pedidos'); vaciar(zona); }
}
