import { api, sesion } from '../api.js';
import { avisarError, aviso, boton, el, fmtDinero, fmtFecha, vaciar } from '../ui.js';

const estados = ['confirmed', 'dispatched', 'delivered', 'partial', 'cancelled'];
const etiquetas = { confirmed: 'Confirmado', dispatched: 'En camino', delivered: 'Entregado', partial: 'Entrega parcial', cancelled: 'Cancelado', pending: 'Pendiente', authorized: 'Autorizado', captured: 'Cobrado', voided: 'Liberado', paid: 'Pagado', failed: 'Fallido', refunded: 'Reembolsado', completed: 'Completado' };
const etiqueta = valor => etiquetas[String(valor).toLowerCase()] ?? 'Por confirmar';

export async function vistaPedidos(raiz) {
  const esAdmin = sesion.esAdmin;
  const esProductor = !esAdmin && sesion.roles.includes('producer');
  const titulo = esAdmin ? 'Todos los pedidos' : esProductor ? 'Ventas recibidas' : 'Mis pedidos';
  const descripcion = esAdmin
    ? 'Registro operativo de compras pendientes, confirmadas y entregadas.'
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
      partes.push(el('div', { class: 'pedido-wallet' }, el('div', {}, el('span', { class: 'pedido-eyebrow' }, 'SALDO DEL SIMULADOR'), el('h2', {}, 'Saldo disponible')), el('div', {}, el('small', {}, 'Disponible para compras simuladas'), el('strong', {}, `${fmtDinero(wallet?.balance ?? 0)} ${wallet?.currency ?? 'COP'}`))));
    }
    const resumen = el('div', { class: 'pedidos-resumen' },
      ...[['Pedidos registrados', orders.length], ['Pendientes', orders.filter(o => o.status === 'pending').length], ['En preparación', orders.filter(o => ['confirmed', 'dispatched'].includes(o.status)).length], ['Entregados', orders.filter(o => o.status === 'delivered').length], ['Parciales', orders.filter(o => o.status === 'partial').length]].map(([titulo, valor]) => el('div', {}, el('span', {}, titulo), el('strong', {}, String(valor)))));
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
    const aceptada = item.acceptedQuantity == null ? null : Number(item.acceptedQuantity);
    const subtotalAceptado = item.acceptedSubtotal == null ? null : Number(item.acceptedSubtotal);
    lineas.append(el('div', { class: 'carrito-item' },
      el('strong', {}, item.productName ?? 'Producto'),
      el('span', {}, aceptada == null ? `${cantidad} kg × ${fmtDinero(unitario)} ${order.currency}` : `${cantidad} kg pedidos · ${aceptada} kg aceptados`),
      el('b', {}, `${fmtDinero(subtotalAceptado ?? subtotal)} ${order.currency}`),
    ));
  }
  const liquidado = Number(order.settledAmount ?? (order.paymentStatus === 'captured' ? order.totalAmount : 0));
  const entregaCerrada = ['delivered', 'partial', 'cancelled'].includes(order.status);
  const puedeCalificar = !esAdmin && !esProductor && ['delivered', 'partial'].includes(order.status) && order.paymentStatus === 'captured';
  const totalVisible = entregaCerrada ? liquidado : Number(order.totalAmount ?? 0);
  const detalle = el('div', { class: 'pedido-detalle', hidden: true },
    el('h3', {}, 'Detalle del pedido'),
    el('p', {}, `Dirección de entrega: ${order.deliveryAddress || 'No registrada'}`),
    el('p', {}, `Estado de pago: ${etiqueta(order.paymentStatus)}`),
    lineas,
    el('strong', { class: 'pedido-total-detalle' }, `${entregaCerrada ? 'Importe liquidado' : esProductor ? 'Total de tus productos' : 'Total del pedido'}: ${fmtDinero(totalVisible)} ${order.currency}`),
    entregaCerrada && liquidado < Number(order.totalAmount) ? el('p', { class: 'pedido-reembolso' }, `Saldo liberado por producto no aceptado: ${fmtDinero(Number(order.totalAmount) - liquidado)} ${order.currency}`) : null,
  );
  let ratingLoaded = false;
  const calificacion = puedeCalificar ? el('section', { class: 'pedido-calificacion' }, el('span', { class: 'pedido-eyebrow' }, 'TU EXPERIENCIA'), el('p', {}, '¿Cómo estuvo tu compra? Cuentanos para ayudar a otros compradores.')) : null;
  if (calificacion) detalle.append(calificacion);
  if (esAdmin) detalle.append(controlEstado(order, recargar));
  const verDetalle = boton('Ver detalles', () => {
    detalle.hidden = !detalle.hidden;
    verDetalle.textContent = detalle.hidden ? 'Ver detalles' : 'Ocultar detalles';
    verDetalle.setAttribute('aria-expanded', String(!detalle.hidden));
    if (!detalle.hidden && calificacion && !ratingLoaded) { ratingLoaded = true; cargarCalificacion(calificacion, order.id); }
  }, 'btn btn-sutil');
  verDetalle.setAttribute('aria-expanded', 'false');
  const nombres = [...new Set((order.items ?? []).map(i => i.productName || 'Producto no disponible'))];
  const cuerpo = el('article', { class: 'pedido-card' },
    el('div', { class: 'pedido-cabecera' },
      el('div', {}, el('span', { class: 'pedido-eyebrow' }, esProductor ? 'VENTA RECIBIDA' : 'COMPRA REGISTRADA'),
        el('h2', {}, nombres.join(' · ') || 'Pedido'), el('small', {}, fmtFecha(order.createdAt))),
      el('span', { class: `pedido-estado ${estados.includes(order.status) ? order.status : 'pending'}` }, etiqueta(order.status)),
    ),
    el('div', { class: 'pedido-pie' }, el('div', {}, el('span', {}, entregaCerrada ? (esProductor ? 'Importe aceptado' : 'Total liquidado') : esProductor ? 'Importe de tus productos' : 'Total de la compra'), el('strong', {}, `${fmtDinero(totalVisible)} ${order.currency ?? 'COP'}`)),
      el('small', {}, `${(order.items ?? []).length} producto(s)`), verDetalle),
    detalle,
  );
  return cuerpo;
}

async function cargarCalificacion(contenedor, orderId) {
  try {
    const rating = await api.verCalificacionPedido(orderId);
    vaciar(contenedor);
    contenedor.append(el('span', { class: 'pedido-eyebrow' }, 'TU EXPERIENCIA'));
    if (rating) {
      contenedor.append(el('strong', { class: 'calificacion-guardada' }, `${'★'.repeat(rating.score)}${'☆'.repeat(5 - rating.score)} · ${rating.score}/5`), el('p', {}, rating.comment || 'Gracias por compartir tu opinión.'));
      return;
    }
    const score = el('select', { name: 'score', class: 'input', required: true, 'aria-label': 'Calificación de 1 a 5' }, [5, 4, 3, 2, 1].map((n) => el('option', { value: n }, `${'★'.repeat(n)}${'☆'.repeat(5 - n)} · ${n}/5`)));
    const comment = el('textarea', { name: 'comment', class: 'input', rows: 2, maxLength: 1000, placeholder: 'Comentario opcional (máximo 1000 caracteres)' });
    const form = el('form', { class: 'form-calificacion', onsubmit: async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; submit.textContent = 'Guardando…';
      try {
        await api.calificarPedido(orderId, { score: Number(score.value), comment: comment.value.trim() || undefined });
        aviso('Gracias por calificar tu pedido', 'Tu opinión quedó registrada.');
        vaciar(contenedor).append(el('span', { class: 'pedido-eyebrow' }, 'TU EXPERIENCIA'), el('strong', { class: 'calificacion-guardada' }, `${'★'.repeat(Number(score.value))}${'☆'.repeat(5 - Number(score.value))} · ${score.value}/5`), comment.value.trim() ? el('p', {}, comment.value.trim()) : el('p', {}, 'Gracias por compartir tu opinión.'));
      } catch (error) { submit.disabled = false; submit.textContent = 'Enviar calificación'; avisarError(error, 'No se pudo guardar tu calificación'); }
    } }, el('label', {}, 'Calificación', score), el('label', {}, 'Comentario', comment), el('button', { type: 'submit', class: 'btn btn-sutil' }, 'Enviar calificación'));
    contenedor.append(el('p', {}, '¿Cómo estuvo tu compra? Cuéntanos para ayudar a otros compradores.'), form);
  } catch (error) { vaciar(contenedor).append(el('p', {}, 'No pudimos consultar tu calificación en este momento.'), boton('Reintentar', () => cargarCalificacion(contenedor, orderId), 'btn btn-sutil')); avisarError(error, 'No se pudo consultar la calificación'); }
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
