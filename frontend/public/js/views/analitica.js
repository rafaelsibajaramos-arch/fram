import { api } from '../api.js';
import { aviso, avisarError, boton, cargando, el, fmtDinero, fmtFecha, fmtKg, seleccion, tabla, tarjeta, vaciar } from '../ui.js';

const REPORTES = [
  ['sales', 'Ventas'], ['waste', 'Mermas'], ['inventory-rotation', 'Rotación de inventario'],
  ['deliveries', 'Entregas'], ['satisfaction', 'Satisfacción'],
];

export async function vistaAnalitica(root) {
  root.append(el('h1', {}, 'Analítica'), el('p', { class: 'subtitulo' }, 'Indicadores operativos basados en hechos confirmados. Las fechas respetan la zona horaria seleccionada y cada informe declara su cobertura.'));
  const tipo = seleccion('tipo', REPORTES, { value: 'sales' });
  const desde = el('input', { name: 'start', type: 'date', value: fechaLocal(-29, 'America/Bogota') });
  const hasta = el('input', { name: 'end', type: 'date', value: fechaLocal(1, 'America/Bogota') });
  const zona = seleccion('timezone', [['UTC', 'UTC'], ['America/Bogota', 'Colombia · Bogotá'], ['America/Mexico_City', 'México · Ciudad de México'], ['America/New_York', 'Estados Unidos · Este']]);
  zona.value = 'America/Bogota';
  const resultados = el('div', { class: 'analitica-resultados' });
  const historial = el('div', {});
  const form = el('form', { class: 'analitica-filtros', onsubmit: (event) => { event.preventDefault(); void consultar(); } },
    field('Reporte', tipo), field('Desde', desde), field('Hasta (exclusivo)', hasta), field('Zona horaria', zona),
    el('div', { class: 'analitica-acciones' }, boton('Consultar', consultar, 'btn btn-sutil'), boton('Guardar informe', guardar, 'btn', 'check')),
  );
  root.append(tarjeta('Periodo del informe', form, { pista: 'La fecha inicial es inclusiva y la final exclusiva. El backend convierte la medianoche de cada zona a UTC.' }), resultados, historial);
  await Promise.all([consultar(), cargarHistorial()]);

  async function consultar() {
    const filters = { start: desde.value, end: hasta.value, timezone: zona.value };
    if (!filters.start || !filters.end || filters.end <= filters.start) { aviso('Revisa el periodo', 'La fecha final debe ser posterior a la inicial.', 'mal'); return; }
    vaciar(resultados).append(cargando('Calculando indicador'));
    try { renderResult(await api.reporteAnalitica(tipo.value, filters)); }
    catch (error) { vaciar(resultados); avisarError(error, 'No se pudo generar el indicador'); }
  }

  async function guardar() {
    try {
      const result = await api.generarReporteAnalitica(tipo.value, { start: desde.value, end: hasta.value, timezone: zona.value });
      aviso('Informe guardado', `${label(tipo.value)} · ${fmtFecha(result.generated_at)}`, 'ok'); await cargarHistorial();
    } catch (error) { avisarError(error, 'No se pudo guardar el informe'); }
  }

  function renderResult(data) {
    vaciar(resultados);
    const summary = el('div', { class: 'analitica-kpis' }, ...kpis(data));
    let detail = null;
    if (data.type === 'sales') detail = tabla([
      { titulo: 'Producto', celda: (row) => el('strong', {}, row.product_name) },
      { titulo: 'Productor', celda: (row) => row.producer_name },
      { titulo: 'Cantidad', celda: (row) => fmtKg(row.kg), num: true },
      { titulo: 'Venta capturada', celda: (row) => `${fmtDinero(row.revenue_cop)} COP`, num: true },
    ], data.by_product, { vacio: 'No hay ventas atribuidas a productos en este periodo.' });
    if (data.type === 'waste') detail = tabla([
      { titulo: 'Producto', celda: (row) => row.product_name },
      { titulo: 'Merma confirmada', celda: (row) => fmtKg(row.kg), num: true },
    ], data.by_product_kg, { vacio: 'No se registraron mermas en este periodo.' });
    if (data.type === 'deliveries') detail = tabla([
      { titulo: 'Ventana comprometida', celda: (row) => `${fmtFecha(row.window_start)} – ${fmtFecha(row.window_end)}` },
      { titulo: 'Estado', celda: (row) => row.status },
      { titulo: 'Puntual', celda: (row) => row.on_time ? 'Sí' : 'No' },
      { titulo: 'Alertas de frío', celda: (row) => row.cold_chain_incidents, num: true },
    ], data.deliveries, { vacio: 'No vencían ventanas de entrega en este periodo.' });
    if (data.type === 'satisfaction') detail = tabla([
      { titulo: 'Calificación', celda: (row) => `${row.score} / 5` },
      { titulo: 'Respuestas', celda: (row) => row.count, num: true },
    ], data.score_distribution, { vacio: 'Aún no hay valoraciones recibidas.' });
    const meta = el('div', { class: 'analitica-meta' },
      el('span', {}, `Cobertura: ${coverage(data.coverage)}`),
      el('span', {}, `Actualizado ${fmtFecha(data.generated_at)}`),
    );
    vaciar(resultados).append(tarjeta(label(data.type), el('div', {}, summary, detail, el('p', { class: 'analitica-formula' }, data.formula ?? ''), meta)));
  }

  function kpis(data) {
    if (data.type === 'sales') return [kpi('Capturado', `${fmtDinero(data.captured_cop)} COP`), kpi('Reembolsado', `${fmtDinero(data.refunded_cop)} COP`), kpi('Sin atribución por producto', `${fmtDinero(data.unallocated_cop)} COP`)];
    if (data.type === 'waste') return [kpi('Merma del periodo', fmtKg(data.wasted_kg)), kpi('Lotes con merma', String(data.harvest_cohorts?.filter((row) => row.wasted_kg > 0).length ?? 0))];
    if (data.type === 'inventory-rotation') return [kpi('Despachado', fmtKg(data.dispatched_kg)), kpi('Stock físico promedio ponderado', fmtKg(data.time_weighted_average_physical_stock_kg)), kpi('Rotaciones', data.rotations == null ? 'Sin dato' : String(data.rotations))];
    if (data.type === 'deliveries') return [kpi('Cumplimiento de ventana', data.window_compliance_percent == null ? 'Sin dato' : `${data.window_compliance_percent}%`), kpi('Duración promedio', data.average_duration_minutes == null ? 'Sin dato' : `${data.average_duration_minutes} min`), kpi('Incidentes de frío', String(data.cold_chain_incidents))];
    return [kpi('Promedio', data.average_score == null ? 'Sin dato' : `${data.average_score} / 5`), kpi('Valoraciones', String(data.rating_count))];
  }

  async function cargarHistorial() {
    try {
      const rows = await api.historialReportesAnalitica(8);
      vaciar(historial).append(tarjeta('Informes guardados', tabla([
        { titulo: 'Reporte', celda: (row) => label(row.reportType) },
        { titulo: 'Periodo', celda: (row) => `${new Date(row.startAt).toLocaleDateString('es-CO')} – ${new Date(row.endAt).toLocaleDateString('es-CO')}` },
        { titulo: 'Zona', celda: (row) => row.timezone },
        { titulo: 'Generado', celda: (row) => fmtFecha(row.generatedAt) },
      ], rows, { vacio: 'Los informes que guardes aparecerán aquí.' })));
    } catch (error) { vaciar(historial); avisarError(error, 'No se pudo cargar el historial'); }
  }
}

function field(title, control) { return el('label', { class: 'campo' }, el('span', {}, title), control); }
function kpi(title, value) { return el('div', { class: 'analitica-kpi' }, el('span', {}, title), el('strong', {}, value)); }
function label(type) { return REPORTES.find(([key]) => key === type)?.[1] ?? type; }
function fechaLocal(offset, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const date = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) + offset));
  return date.toISOString().slice(0, 10);
}
function coverage(value) { return ({ complete: 'completa', partial_capture_or_missing_order_or_fulfillment_lines: 'parcial · captura o detalle de pedido incompleto', partial_missing_batch_or_harvest_reference: 'parcial · lote o cosecha de origen no informado', partial_tracked_lots_with_pre_period_snapshot: 'parcial · solo lotes con saldo inicial conocido', no_data_missing_initial_stock_snapshots: 'sin saldo inicial suficiente', complete_for_scheduled_deliveries: 'entregas programadas recibidas', no_data: 'sin datos' })[value] ?? value ?? 'no informada'; }
