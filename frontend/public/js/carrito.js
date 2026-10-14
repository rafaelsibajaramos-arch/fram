import { api, sesion } from './api.js';
import { el, boton, vaciar, fmtDinero, aviso } from './ui.js';

export function instalarCarrito(trigger, alComprar) {
  let busy = false, items = [], productos = new Map(), direccion = '', pendiente = null;
  const contenido = el('div', { class: 'carrito-contenido' });
  const cerrar = () => { if (!busy) { drawer.hidden = true; trigger.focus(); } };
  const close = boton('×', cerrar, 'btn-icono'); close.setAttribute('aria-label', 'Cerrar carrito');
  const drawer = el('aside', { class: 'carrito-drawer carrito-premium', hidden: true, 'aria-label': 'Mi carrito' },
    el('div', { class: 'carrito-drawer-cabecera' }, el('div', {}, el('small', { class: 'pedido-eyebrow' }, 'DEL CAMPO A TU MESA'), el('strong', {}, 'Mi carrito')), close), contenido);
  document.body.append(drawer);
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(); });
  const precio = i => Number(i.unitPrice ?? 0);
  const serializar = lista => lista.map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: precio(i), ...(i.priceVersionId ? { priceVersionId: i.priceVersionId } : {}) }));
  function bloquear(value) { busy = value; drawer.querySelectorAll('button,input').forEach(n => { n.disabled = value; }); }
  async function guardar(nuevos) {
    if (busy || pendiente) return;
    bloquear(true);
    try { await api.guardarCarrito(sesion.userId, { items: serializar(nuevos) }); items = nuevos; pintar(); }
    catch (e) { pintar(e.message || 'No se pudo guardar el cambio.'); }
    finally { busy = false; close.disabled = false; }
  }
  function pintar(mensaje = '') {
    vaciar(contenido);
    if (!items.length) { contenido.append(el('div', { class: 'pedido-vacio' }, el('h3', {}, 'Tu carrito está vacío'), el('p', {}, 'Elige productos del catálogo para comenzar.'), boton('Seguir explorando', cerrar, 'btn btn-sutil'))); return; }
    contenido.append(el('p', { class: 'carrito-ayuda' }, `${items.length} producto(s) · Cantidades en kilogramos`));
    for (const item of items) {
      const p = productos.get(item.productId);
      const nombre = p?.name || 'Producto no disponible';
      const min = Math.max(.001, Number(p?.min_order_quantity || .001));
      const cantidad = el('input', { type: 'number', min, step: '.001', value: item.quantity, 'aria-label': `Cantidad de ${nombre}`, disabled: !!pendiente });
      const cambiar = value => {
        if (!Number.isFinite(value) || value < min) { cantidad.value = item.quantity; cantidad.setCustomValidity(`La compra mínima es ${min} kg`); cantidad.reportValidity(); return; }
        void guardar(items.map(i => i === item ? { ...i, quantity: Number(value.toFixed(3)) } : i));
      };
      cantidad.addEventListener('input', () => cantidad.setCustomValidity(''));
      cantidad.addEventListener('change', () => cambiar(Number(cantidad.value)));
      const menos = boton('−', () => cambiar(Math.max(min, Number(item.quantity) - 1)), 'carrito-ajuste');
      menos.disabled = !!pendiente || Number(item.quantity) <= min; menos.setAttribute('aria-label', `Reducir ${nombre}`);
      const mas = boton('+', () => cambiar(Number(item.quantity) + 1), 'carrito-ajuste'); mas.disabled = !!pendiente; mas.setAttribute('aria-label', `Aumentar ${nombre}`);
      const quitar = boton('Quitar', () => guardar(items.filter(i => i !== item)), 'carrito-quitar'); quitar.disabled = !!pendiente; quitar.setAttribute('aria-label', `Quitar ${nombre}`);
      contenido.append(el('section', { class: 'carrito-producto' },
        el('div', { class: 'carrito-producto-titulo' }, el('strong', {}, nombre), quitar),
        el('small', {}, `${fmtDinero(precio(item))} COP / kg · Mínimo ${min} kg`),
        el('div', { class: 'carrito-producto-precio' }, el('div', { class: 'carrito-cantidad' }, menos, cantidad, mas), el('b', {}, `${fmtDinero(precio(item) * Number(item.quantity))} COP`))));
    }
    const address = el('input', { id: 'carrito-direccion', value: direccion, placeholder: 'Calle, número, ciudad y referencias', required: true, disabled: !!pendiente });
    address.addEventListener('input', () => { direccion = address.value; address.setCustomValidity(''); });
    const error = el('p', { class: 'carrito-error', role: 'alert', hidden: !mensaje }, mensaje);
    const pagar = boton(pendiente ? 'Reintentar confirmación' : 'Confirmar y pagar', async () => {
      if (busy) return;
      if (!direccion.trim()) { address.setCustomValidity('Indica la dirección de entrega'); address.reportValidity(); return; }
      pendiente ??= { buyerId: sesion.userId, deliveryAddress: direccion.trim(), items: items.map(i => ({ productId: i.productId, quantity: Number(i.quantity) })), idempotencyKey: crypto.randomUUID() };
      bloquear(true); pagar.textContent = 'Procesando compra…';
      try { await api.confirmarCheckout(pendiente); pendiente = null; items = []; direccion = ''; drawer.hidden = true; aviso('Compra confirmada', 'Puedes consultar los detalles en tus pedidos.'); await alComprar(); }
      catch (e) { pintar(`${e.message || 'No se pudo confirmar.'} Reintenta sin modificar la compra para evitar cobros duplicados.`); }
      finally { busy = false; close.disabled = false; }
    }, 'btn');
    contenido.append(el('div', { class: 'carrito-checkout' },
      el('div', { class: 'carrito-total' }, el('span', {}, 'Total estimado'), el('strong', {}, `${fmtDinero(items.reduce((s,i) => s + precio(i) * Number(i.quantity), 0))} COP`)),
      el('small', {}, 'El precio y la disponibilidad se validan al confirmar.'),
      el('label', { htmlFor: 'carrito-direccion' }, 'Dirección de entrega'), address, error, pagar,
      el('small', { class: 'carrito-metodo' }, 'Pago con tu saldo TerraWallet')));
  }
  trigger.onclick = async () => {
    if (!sesion.activa) { location.hash = '#/login'; return; }
    if (busy) return;
    if (pendiente && pendiente.buyerId !== sesion.userId) { pendiente = null; direccion = ''; }
    drawer.hidden = false;
    if (pendiente) { pintar(); close.focus(); return; }
    busy = true; contenido.textContent = 'Cargando tu carrito…';
    try {
      items = (await api.verCarrito(sesion.userId))?.items ?? [];
      productos = new Map(await Promise.all(items.map(async i => { try { return [i.productId, await api.verProducto(i.productId)]; } catch { return [i.productId, null]; } })));
      pintar(); close.focus();
    } catch (e) { contenido.textContent = e.message || 'No se pudo cargar el carrito.'; }
    finally { busy = false; }
  };
}
