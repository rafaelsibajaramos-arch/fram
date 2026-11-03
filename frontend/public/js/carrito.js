import { api, sesion } from './api.js';
import { el, boton, vaciar, fmtDinero, aviso } from './ui.js';
import { locationPicker } from './logistics-map.js';

export function instalarCarrito(trigger, alComprar) {
  let busy = false, items = [], productos = new Map(), direccion = '', pendiente = cargarPendiente();
  let puntoEntrega = pendiente?.deliveryLatitude != null ? { latitude: pendiente.deliveryLatitude, longitude: pendiente.deliveryLongitude } : null;
  let datosDireccion = {};
  let usuarioDireccion = sesion.userId;
  const contenido = el('div', { class: 'carrito-contenido' });
  const cerrar = () => { if (!busy) { drawer.hidden = true; trigger.focus(); } };
  const close = boton('×', cerrar, 'btn-icono'); close.setAttribute('aria-label', 'Cerrar carrito');
  const drawer = el('aside', { class: 'carrito-drawer carrito-premium', hidden: true, 'aria-label': 'Mi carrito' },
    el('div', { class: 'carrito-drawer-cabecera' }, el('div', {}, el('small', { class: 'pedido-eyebrow' }, 'DEL CAMPO A TU MESA'), el('strong', {}, 'Mi carrito')), close), contenido);
  document.body.append(drawer);
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(); });
  const precio = i => Number(i.unitPrice ?? 0);
  const clavePendiente = () => `ftt_checkout_pendiente_${sesion.userId ?? 'anonimo'}`;
  function cargarPendiente() {
    if (!sesion.userId) return null;
    try {
      const raw = sessionStorage.getItem(`ftt_checkout_pendiente_${sesion.userId}`);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return saved?.buyerId === sesion.userId && typeof saved?.idempotencyKey === 'string' && Array.isArray(saved?.items) ? saved : null;
    } catch { return null; }
  }
  function guardarPendiente() {
    try { sessionStorage.setItem(clavePendiente(), JSON.stringify(pendiente)); }
    catch { /* La compra sigue siendo segura por la clave en memoria */ }
  }
  function limpiarPendiente() {
    try { sessionStorage.removeItem(clavePendiente()); } catch { /* almacenamiento no disponible */ }
    pendiente = null;
  }
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
    const ubicacion = pendiente ? el('p', { class: 'pista' }, 'Se conserva la ubicación de este intento de compra.') : locationPicker({ ...puntoEntrega, addressInput: address, addressState: datosDireccion, onAddressChange: state => { datosDireccion = state; }, title: 'Dirección y referencias de entrega', onChange: p => { puntoEntrega = p; } });
    address.addEventListener('input', () => { direccion = address.value; address.setCustomValidity(''); puntoEntrega = null; ubicacion.clear?.(); });
    const error = el('p', { class: 'carrito-error', role: 'alert', hidden: !mensaje }, mensaje);
    const pagar = boton('Realizar pago', async () => {
      if (busy) return;
      if (!direccion.trim()) { address.setCustomValidity('Indica la dirección de entrega'); address.reportValidity(); return; }
      if (!pendiente && !puntoEntrega) { aviso('Confirma el destino', 'Selecciona el punto exacto de entrega en el mapa.', 'mal'); return; }
      pendiente ??= { buyerId: sesion.userId, deliveryAddress: ubicacion.addressValue?.() || direccion.trim(), deliveryLatitude: puntoEntrega.latitude, deliveryLongitude: puntoEntrega.longitude, items: items.map(i => ({ productId: i.productId, quantity: Number(i.quantity), estimatedUnitPrice: precio(i) })), idempotencyKey: crypto.randomUUID() };
      guardarPendiente();
      bloquear(true); pagar.textContent = 'Procesando compra…';
      try {
        await api.configuracionWompi();
        const result = await api.iniciarCheckoutSaga(pendiente);
        let order = result?.order ?? result;
        pendiente.orderId = order.id; guardarPendiente();
        let checkout;
        for (let i = 0; i < 12; i++) {
          try { checkout = await api.checkoutWompi(order.id); break; }
          catch (error) { if (![404, 409].includes(error.status)) throw error; await new Promise(r => setTimeout(r, 1000)); }
          order = await api.verPedido(order.id);
          if (order.status === 'cancelled') throw Object.assign(new Error('No se pudo reservar el inventario. Inicia una compra nueva.'), { status: 409 });
        }
        if (checkout) { location.assign(checkout.checkoutUrl); return; }
        if (order.status !== 'confirmed') { pintar('La reserva sigue en proceso. Reintenta o consulta Mis pedidos; se conserva la misma referencia.'); return; }
        limpiarPendiente(); items = []; direccion = ''; drawer.hidden = true; aviso('Compra confirmada', 'Puedes consultar los detalles en tus pedidos.'); await alComprar();
      }
      catch (e) {
        const operacionCompensada = e.status === 409;
        if (operacionCompensada) limpiarPendiente();
        else {
          guardarPendiente();
          // Si el servidor alcanzó a guardar el pedido antes del timeout,
          // conservar su ID permite consultar su estado sin crear otro.
          try {
            const anteriores = await api.listarPedidos();
            const existente = anteriores.find(order => order.idempotencyKey === pendiente.idempotencyKey);
            if (existente) { pendiente.orderId = existente.id; guardarPendiente(); }
          } catch { /* El reintento conserva la misma clave aunque la consulta falle */ }
        }
        pintar(`${e.message || 'No se pudo confirmar.'} ${operacionCompensada ? 'El carrito sigue disponible; confirma de nuevo para generar una reserva nueva.' : 'Puedes reintentar sin modificar la compra; el pago usa la misma clave idempotente.'}`);
      }
      finally { busy = false; close.disabled = false; }
    }, 'btn');
    contenido.append(el('div', { class: 'carrito-checkout' },
      el('div', { class: 'carrito-total' }, el('span', {}, 'Total estimado'), el('strong', {}, `${fmtDinero(items.reduce((s,i) => s + precio(i) * Number(i.quantity), 0))} COP`)),
      el('small', {}, 'El precio y la disponibilidad se validan al confirmar.'),
      el('label', { htmlFor: 'carrito-direccion' }, 'Dirección de entrega'), address, ubicacion, error, pagar,
      el('small', { class: 'carrito-metodo' }, 'Pago exclusivo por Wompi Sandbox · entorno de pruebas')));
  }
  trigger.onclick = async () => {
    if (!sesion.activa) { location.hash = '#/login'; return; }
    if (busy) return;
    if (usuarioDireccion !== sesion.userId) { usuarioDireccion = sesion.userId; direccion = ''; datosDireccion = {}; puntoEntrega = null; }
    if (pendiente && pendiente.buyerId !== sesion.userId) { limpiarPendiente(); direccion = ''; }
    drawer.hidden = false;
    if (pendiente) {
      direccion = pendiente.deliveryAddress ?? '';
      items = pendiente.items.map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.estimatedUnitPrice ?? 0) }));
      if (!pendiente.orderId) {
        try {
          const anteriores = await api.listarPedidos();
          const existente = anteriores.find(order => order.idempotencyKey === pendiente.idempotencyKey);
          if (existente) { pendiente.orderId = existente.id; guardarPendiente(); }
        } catch { /* Aún no existe o el historial no está disponible */ }
      }
      if (pendiente.orderId) {
        try {
          const order = await api.verPedido(pendiente.orderId);
          if (order.status === 'confirmed') {
            limpiarPendiente(); items = []; drawer.hidden = true; aviso('Compra confirmada', 'Puedes consultar los detalles en tus pedidos.'); await alComprar(); return;
          }
          if (order.status === 'cancelled') {
            limpiarPendiente(); direccion = '';
            items = (await api.verCarrito(sesion.userId))?.items ?? [];
            productos = new Map(await Promise.all(items.map(async i => { try { return [i.productId, await api.verProducto(i.productId)]; } catch { return [i.productId, null]; } })));
            pintar('El intento anterior fue cancelado. Tu carrito sigue disponible para iniciar una compra nueva.'); close.focus(); return;
          }
          if (Array.isArray(order.items) && order.items.length) {
            items = order.items.map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), priceVersionId: i.priceVersionId }));
            direccion = order.deliveryAddress ?? direccion;
          }
        } catch { /* El checkout sigue siendo reintentable con la misma clave */ }
      }
      productos = new Map(await Promise.all(items.map(async i => { try { return [i.productId, await api.verProducto(i.productId)]; } catch { return [i.productId, null]; } })));
      pintar('Hay una compra en proceso. Reintentar usará la misma referencia para evitar duplicar el cobro.'); close.focus(); return;
    }
    busy = true; contenido.textContent = 'Cargando tu carrito…';
    try {
      items = (await api.verCarrito(sesion.userId))?.items ?? [];
      productos = new Map(await Promise.all(items.map(async i => { try { return [i.productId, await api.verProducto(i.productId)]; } catch { return [i.productId, null]; } })));
      pintar(); close.focus();
    } catch (e) { contenido.textContent = e.message || 'No se pudo cargar el carrito.'; }
    finally { busy = false; }
  };
}

