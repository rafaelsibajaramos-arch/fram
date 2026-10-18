import { api } from '../api.js';
import { avisarError, aviso, boton, el, fmtFecha, vaciar } from '../ui.js';

const tipos = [
  ['order.confirmed', 'Pedido confirmado'], ['order.cancelled', 'Pedido cancelado'],
  ['delivery.scheduled', 'Entrega programada'], ['delivery.completed', 'Entrega completada'],
  ['delivery.partial', 'Entrega parcial'], ['delivery.failed', 'Entrega fallida'],
  ['payment.authorized', 'Pago autorizado'], ['payment.captured', 'Pago confirmado'], ['payment.failed', 'Pago rechazado'], ['payment.refunded', 'Reembolso'],
  ['payout.scheduled', 'Liquidación programada'], ['payout.completed', 'Liquidación completada'],
  ['cold_chain.alert', 'Cadena de frío'], ['product.available', 'Producto disponible'],
];

export async function vistaNotificaciones(raiz) {
  raiz.append(el('div', { class: 'notificaciones-hero' },
    el('div', {}, el('span', { class: 'pedido-eyebrow' }, 'TU ACTIVIDAD, EN UN SOLO LUGAR'), el('h1', {}, 'Notificaciones'), el('p', { class: 'subtitulo' }, 'Actualizaciones de pedidos, pagos y entregas.')),
    el('span', { class: 'notificaciones-icono', 'aria-hidden': 'true' }, '✦')));
  const contenido = el('div', { class: 'notificaciones-layout' });
  const lista = el('section', { class: 'notificaciones-panel' }, el('div', { class: 'notificaciones-panel-titulo' }, el('div', {}, el('h2', {}, 'Tu bandeja'), el('p', {}, 'Los avisos importantes se guardan aquí aunque desactives el correo.'))), el('p', {}, 'Cargando notificaciones…'));
  const preferencias = el('section', { class: 'notificaciones-panel' }, el('h2', {}, 'Preferencias de correo'), el('p', {}, 'Elige qué avisos adicionales quieres recibir por email. Los avisos operativos importantes permanecen en la bandeja.'));
  contenido.append(lista, preferencias); raiz.append(contenido);

  try {
    const [items, saved] = await Promise.all([api.listarNotificaciones(100), api.preferenciasNotificacion()]);
    const prefMap = new Map(saved.map((pref) => [`${pref.notificationType}:${pref.channel}`, pref.enabled]));
    vaciar(lista).append(el('div', { class: 'notificaciones-panel-titulo' }, el('div', {}, el('h2', {}, 'Tu bandeja'), el('p', {}, `${items.length} aviso(s) recientes`))));
    if (!items.length) lista.append(el('div', { class: 'notificaciones-vacio' }, el('span', {}, '✦'), el('strong', {}, 'Todo está al día'), el('p', {}, 'Cuando haya novedades importantes, las encontrarás aquí.')));
    for (const item of items) {
      const card = el('article', { class: `notificacion-card${item.status === 'sent' ? ' no-leida' : ''}` },
        el('span', { class: 'notificacion-punto', 'aria-hidden': 'true' }),
        el('div', { class: 'notificacion-cuerpo' }, el('div', { class: 'notificacion-meta' }, el('strong', {}, item.title), el('time', {}, fmtFecha(item.createdAt))), el('p', {}, item.message), el('small', {}, etiquetaCanal(item.channel))),
        item.status === 'sent' ? boton('Marcar leída', async () => {
          try { await api.marcarNotificacionLeida(item.id); card.classList.remove('no-leida'); card.querySelector('button')?.remove(); aviso('Aviso actualizado', 'Marcado como leído.'); }
          catch (error) { avisarError(error, 'No se pudo actualizar'); }
        }, 'btn btn-sutil btn-xs') : null);
      lista.append(card);
    }

    const filas = el('div', { class: 'preferencias-lista' });
    for (const [type, label] of tipos) {
      const input = el('input', { type: 'checkbox', checked: prefMap.get(`${type}:email`) === true, 'aria-label': `Recibir por email: ${label}` });
      input.addEventListener('change', async () => {
        input.disabled = true;
        try { await api.guardarPreferenciaNotificacion({ notification_type: type, channel: 'email', enabled: input.checked }); aviso('Preferencia guardada', label); }
        catch (error) { input.checked = !input.checked; avisarError(error, 'No se pudo guardar la preferencia'); }
        finally { input.disabled = false; }
      });
      filas.append(el('label', { class: 'preferencia-fila' }, el('span', {}, label), input));
    }
    preferencias.append(filas, el('small', { class: 'notificaciones-nota' }, 'Los avisos dentro de FarmToTable no requieren correo. SMS estará disponible al registrar un teléfono verificado y configurar el proveedor.'));
  } catch (error) {
    avisarError(error, 'No se pudieron cargar las notificaciones');
    vaciar(lista).append(el('div', { class: 'notificaciones-vacio' }, el('strong', {}, 'No se pudo cargar tu bandeja'), boton('Reintentar', () => vistaNotificaciones(raiz), 'btn btn-sutil')));
    preferencias.append(el('p', {}, 'No fue posible consultar tus preferencias. Intenta de nuevo más tarde.'));
  }
}

function etiquetaCanal(channel) { return ({ in_app: 'En la aplicación', email: 'Correo electrónico', sms: 'SMS' })[channel] ?? 'Notificación'; }
