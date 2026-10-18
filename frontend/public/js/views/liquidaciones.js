import { api, sesion } from '../api.js';
import { avisarError, aviso, boton, el, fmtDinero, fmtFecha, tarjeta, tabla, vaciar } from '../ui.js';

const estados = { draft: 'Borrador', scheduled: 'Programada', paid: 'Pagada', failed: 'Fallida', carried: 'Ajuste pendiente' };

export async function vistaLiquidaciones(raiz) {
  const admin = sesion.esAdmin;
  raiz.append(
    el('h1', {}, admin ? 'Liquidaciones a productores' : 'Mis liquidaciones'),
    el('p', { class: 'subtitulo' }, admin
      ? 'Revisa los importes aceptados y registra la referencia cuando la transferencia externa haya sido realizada.'
      : 'Consulta el detalle de tus ventas aceptadas, comisiones y pagos registrados.'),
  );
  const zona = el('div', {});
  raiz.append(zona, el('p', { class: 'pista' }, 'Las liquidaciones reflejan el saldo del libro contable; el estado “Pagada” requiere una referencia de transferencia confirmada por administración.'));

  const cargar = async () => {
    vaciar(zona).append(el('p', {}, 'Cargando liquidaciones…'));
    try {
      const payouts = await api.listarLiquidaciones();
      if (!payouts.length) {
        vaciar(zona).append(tarjeta('Aún no hay liquidaciones', el('p', {}, 'Cuando se cierre una entrega con productos aceptados, el importe aparecerá aquí.')));
        return;
      }
      const rows = payouts.map((payout) => ({
        periodo: `${fechaCorta(payout.periodStart)} – ${fechaCorta(payout.periodEnd)}`,
        productor: payout.items?.[0]?.chargeDetail?.producerName || 'Productor',
        pedidos: new Set((payout.items ?? []).map((item) => item.orderId)).size,
        lineas: payout.items?.length ?? 0,
        gross: `${fmtDinero(payout.grossAmount)} COP`,
        refunds: `${fmtDinero(payout.refundAmount)} COP`,
        commission: `${fmtDinero(payout.commissionAmount)} COP`,
        adjustment: `${fmtDinero(payout.adjustmentAmount)} COP`,
        net: `${fmtDinero(payout.netAmount)} COP`,
        status: payout.status,
        payout,
      }));
      const columns = [
        { titulo: 'Periodo', celda: (row) => row.periodo },
        ...(admin ? [{ titulo: 'Productor', celda: (row) => row.productor }] : []),
        { titulo: 'Pedidos / líneas', celda: (row) => `${row.pedidos} / ${row.lineas}` },
        { titulo: 'Ventas aceptadas', celda: (row) => row.gross },
        { titulo: 'Reembolsos', celda: (row) => row.refunds },
        { titulo: 'Comisión', celda: (row) => row.commission },
        { titulo: 'Ajustes', celda: (row) => row.adjustment },
        { titulo: 'Neto', celda: (row) => el('strong', {}, row.net) },
        { titulo: 'Estado', celda: (row) => el('span', { class: `insignia ${row.status === 'paid' ? 'ok' : row.status === 'failed' ? 'mal' : 'info'}` }, estados[row.status] ?? row.status) },
        { titulo: 'Referencia', celda: (row) => row.payout.providerReference || '—' },
        ...(admin ? [{ titulo: 'Acción', celda: (row) => row.status === 'scheduled' && Number(row.payout.netAmount) > 0
          ? boton('Registrar pago', async () => {
            const reference = prompt('Referencia bancaria o comprobante de la transferencia realizada:')?.trim();
            if (!reference) return;
            try { await api.completarLiquidacion(row.payout.id, reference); aviso('Transferencia registrada', 'La liquidación quedó marcada como pagada.'); await cargar(); }
            catch (error) { avisarError(error, 'No se pudo registrar el pago'); }
          }, 'btn btn-sutil btn-chico')
          : el('span', { class: 'pista' }, row.status === 'paid' ? 'Transferencia registrada' : 'Sin acción') }] : []),
      ];
      const body = el('div', { class: 'tabla-contenedor' }, tabla(columns, rows, { vacio: 'No hay liquidaciones para mostrar.' }));
      vaciar(zona).append(tarjeta('Registro contable', body), ...rows.map((row) => detalle(row.payout)));
    } catch (error) {
      avisarError(error, 'No se pudieron cargar las liquidaciones');
      vaciar(zona).append(el('p', {}, 'No pudimos cargar las liquidaciones.'), boton('Reintentar', cargar, 'btn btn-sutil'));
    }
  };
  await cargar();
}

function detalle(payout) {
  const lineas = (payout.items ?? []).map((item) => el('tr', {},
    el('td', {}, item.chargeDetail?.productName ?? 'Producto'),
    el('td', {}, `${fmtDinero(item.chargeDetail?.acceptedQuantity ?? 0)} kg`),
    el('td', {}, `${fmtDinero(item.grossAmount)} COP`),
    el('td', {}, `${fmtDinero(item.commissionAmount)} COP`),
    el('td', {}, `${fmtDinero(item.netAmount)} COP`),
  ));
  const table = el('table', { class: 'tabla' },
    el('thead', {}, el('tr', {}, ...['Producto', 'Cantidad aceptada', 'Bruto', 'Comisión', 'Neto'].map((label) => el('th', {}, label)))),
    el('tbody', {}, ...(lineas.length ? lineas : [el('tr', {}, el('td', { colspan: 5 }, 'Sin líneas asociadas'))])),
  );
  const period = `${fechaCorta(payout.periodStart)} – ${fechaCorta(payout.periodEnd)}`;
  return tarjeta(`Detalle · ${period}`, el('div', {}, table,
    el('p', { class: 'pista' }, `Estado: ${estados[payout.status] ?? payout.status}${payout.providerReference ? ` · Referencia: ${payout.providerReference}` : ''}`),
    payout.updatedAt ? el('small', { class: 'pista' }, `Actualizada ${fmtFecha(payout.updatedAt)}`) : null,
  ));
}

function fechaCorta(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('es-CO', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}
