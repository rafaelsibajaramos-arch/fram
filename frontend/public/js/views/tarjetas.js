import { api, sesion } from '../api.js';
import { aviso, avisarError, boton, el, entrada, fmtDinero, tarjeta } from '../ui.js';

const MARCAS = ['Visa', 'Mastercard', 'American Express'];
const fmtFecha = (card) => `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`;

export async function vistaTarjetas(raiz) {
  raiz.append(el('h1', {}, 'Tarjetas simuladas'), el('p', { class: 'subtitulo' }, 'Genera tarjetas ficticias para elegir con cuál identificar tus compras. No se procesan tarjetas ni pagos reales.'));
  const content = el('div', {}); raiz.append(content);
  async function cargar() {
    content.textContent = 'Cargando tarjetas…';
    try {
      const [cards, wallet] = await Promise.all([api.listarTarjetas(sesion.userId), api.verBilletera(sesion.userId)]);
      content.replaceChildren();
      content.append(tarjeta('Saldo común del simulador', el('div', { class: 'tarjetas-saldo' },
        el('div', {}, el('small', {}, 'Disponible para pagar con cualquiera de tus tarjetas'), el('strong', {}, `${fmtDinero(wallet?.balance ?? 0)} ${wallet?.currency ?? 'COP'}`)),
        el('a', { href: '#/pedidos', class: 'btn btn-sutil' }, 'Ver pedidos'))));
      const loadForm = el('form', { class: 'tarjetas-recarga' });
      const amount = entrada('amount', { type: 'number', min: '0.01', step: '0.01', required: true, placeholder: 'Monto en COP' });
      const load = boton('Agregar saldo simulado'); load.type = 'submit';
      loadForm.append(el('label', { class: 'campo' }, el('span', {}, 'Monto a agregar (COP)'), amount), load,
        el('p', { class: 'pista' }, 'Recarga ficticia sin tope definido por la aplicación. Se agrega al saldo común, no a una tarjeta específica.'));
      loadForm.addEventListener('submit', async (event) => {
        event.preventDefault(); const value = Number(amount.value);
        if (!Number.isFinite(value) || value <= 0) return;
        load.disabled = true;
        try { await api.recargarBilletera(sesion.userId, { amount: value, reason: 'Recarga simulada por el usuario', idempotencyKey: crypto.randomUUID() }); aviso('Saldo agregado', `${fmtDinero(value)} COP simulados`); await cargar(); }
        catch (error) { avisarError(error, 'No se pudo agregar saldo'); load.disabled = false; }
      });
      content.append(tarjeta('Agregar saldo', loadForm));
      const form = el('form', { class: 'tarjetas-form' });
      const brand = el('select', { name: 'brand', required: true }, ...MARCAS.map((name) => el('option', { value: name }, name)));
      const holder = entrada('holderName', { required: true, maxlength: 120, minlength: 2, placeholder: 'Nombre del titular' });
      const generate = boton('Generar tarjeta'); generate.type = 'submit';
      form.append(el('label', { class: 'campo' }, el('span', {}, 'Franquicia'), brand), el('label', { class: 'campo' }, el('span', {}, 'Nombre del titular'), holder),
        el('p', { class: 'pista' }, 'El generador asigna automáticamente los últimos dígitos y la fecha de vencimiento. No se solicita número ni código de seguridad.'),
        generate);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (generate.disabled) return;
        generate.disabled = true;
        try { await api.crearTarjeta(sesion.userId, { brand: brand.value, holderName: holder.value.trim() }); aviso('Tarjeta generada', 'Ya puedes seleccionarla al pagar.'); await cargar(); }
        catch (error) { avisarError(error, 'No se pudo generar la tarjeta'); generate.disabled = false; }
      });
      content.append(tarjeta('Generador de tarjetas', form));
      const list = el('div', { class: 'tarjetas-lista' });
      if (!cards.length) list.append(el('div', { class: 'pedido-vacio' }, el('h3', {}, 'Aún no tienes tarjetas'), el('p', {}, 'Genera una arriba. Puedes crear varias y elegir una diferente en cada compra.')));
      for (const card of cards) {
        const remove = boton('Eliminar', async () => {
          if (!confirm(`¿Eliminar tu tarjeta ${card.brand} •••• ${card.last4}? El saldo común no se perderá.`)) return;
          try { await api.eliminarTarjeta(sesion.userId, card.id); aviso('Tarjeta eliminada', 'El saldo común del simulador se conserva.'); await cargar(); }
          catch (error) { avisarError(error, 'No se pudo eliminar la tarjeta'); }
        }, 'btn btn-sutil btn-chico');
        list.append(el('article', { class: `tarjeta-simulada marca-${card.brand.toLowerCase().replaceAll(' ', '-')}` },
          el('div', { class: 'tarjeta-simulada-top' }, el('span', {}, 'FARMTOTABLE · SIMULADA'), el('strong', {}, card.brand)),
          el('div', { class: 'tarjeta-simulada-numero' }, `••••  ••••  ••••  ${card.last4}`),
          el('div', { class: 'tarjeta-simulada-bottom' }, el('div', {}, el('small', {}, 'TITULAR'), el('strong', {}, card.holderName)), el('div', {}, el('small', {}, 'VENCE'), el('strong', {}, fmtFecha(card))), remove)));
      }
      content.append(tarjeta(`Tus tarjetas (${cards.length})`, list));
      content.append(el('p', { class: 'pista' }, 'Simulador académico: saldo y pagos ficticios. No ingreses ni compartas datos de tarjetas reales.'));
    } catch (error) { content.replaceChildren(el('p', {}, 'No se pudo cargar el simulador de tarjetas.'), boton('Reintentar', cargar, 'btn btn-sutil')); avisarError(error, 'No se pudo cargar tarjetas'); }
  }
  await cargar();
}
