import { api, sesion } from '../api.js';
import { aviso, avisarError, boton, campo, entrada, el, fmtDinero, fmtFecha, vaciar } from '../ui.js';

export async function vistaPedidos(raiz) {
  raiz.append(el('h1', {}, 'Mis pedidos'), el('p', { class: 'subtitulo' }, 'Carrito, checkout y seguimiento de compras.'));
  const zona = el('div', {}); raiz.append(zona); await cargar(zona);
  async function cargar(destino) {
    vaciar(destino).append(el('p', {}, 'Cargando pedidos…'));
    try {
      const [cart, orders] = await Promise.all([api.verCarrito(sesion.userId), api.listarPedidos(sesion.userId)]);
      const items = cart?.items ?? [];
      const carrito = el('div', { class: 'tarjeta' }, el('h2', {}, `Carrito (${items.length})`));
      if (!items.length) carrito.append(el('p', {}, 'El carrito está vacío. Puedes agregar productos desde Catálogo.'));
      else {
        carrito.append(...items.map((item) => el('p', {}, `${item.productId} · ${item.quantity} kg · ${fmtDinero(item.unitPrice)}`)));
        const address = entrada('deliveryAddress', { placeholder: 'Dirección de entrega' });
        carrito.append(campo('Dirección', address), boton('Confirmar pedido', async () => {
          try {
            const order = await api.crearPedido({ buyerId: sesion.userId, deliveryAddress: address.value, items: items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice ?? 0), priceVersionId: i.priceVersionId })) });
            const payment = await api.crearPago({ orderId: order.id, buyerId: sesion.userId, amount: Number(order.totalAmount), currency: order.currency });
            await api.autorizarPago(payment.id);
            aviso('Compra completada', `Pedido ${order.id.slice(0, 8)} · pago autorizado`); await cargar(destino);
          } catch (error) { avisarError(error, 'No se pudo crear el pedido'); }
        }, 'btn'));
      }
      const lista = el('div', { class: 'tarjeta' }, el('h2', {}, 'Historial'));
      if (!orders.length) lista.append(el('p', {}, 'Aún no tienes pedidos.'));
      for (const order of orders) lista.append(el('article', { class: 'bloque' }, el('strong', {}, `${order.status} · ${fmtDinero(order.totalAmount)} ${order.currency}`), el('small', {}, ` ${fmtFecha(order.createdAt)}`), el('p', {}, `${order.items?.length ?? 0} productos · ${order.deliveryAddress}`)));
      vaciar(destino).append(carrito, lista);
    } catch (error) { avisarError(error, 'No se pudieron cargar los pedidos'); vaciar(destino); }
  }
}
