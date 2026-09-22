import { api } from '../api.js';
import { avisarError, aviso, boton, cargando, el, entrada, pie, tabla, tarjeta, vaciar } from '../ui.js';

export async function vistaValidaciones(raiz) {
  raiz.append(el('h1', {}, 'Validación documental'), el('p', { class: 'subtitulo' }, 'Revisa certificados cargados por productores y deja una decisión auditable.'));
  const zona = el('div', {}); raiz.append(zona); vaciar(zona).append(cargando());
  try {
    const pendientes = await api.certificacionesPendientes();
    vaciar(zona).append(tarjeta('Pendientes de revisión', tabla([
      { titulo: 'Tipo', celda: (c) => c.type },
      { titulo: 'Expedición', celda: (c) => c.issue_date },
      {
        titulo: 'Documento',
        celda: (c) => c.file
          ? boton(c.file.name, async () => {
              try { await api.abrirArchivoCertificacion(c.id, c.file.name); }
              catch (err) { avisarError(err, 'No se pudo abrir el documento'); }
            }, 'btn btn-sutil btn-chico')
          : 'Sin archivo',
      },
      { titulo: 'Decisión', celda: (c) => {
        const notes = entrada('notes', { placeholder: 'Observación opcional' });
        return el('div', { class: 'acciones-validacion' }, notes,
          boton('Aprobar', async () => decidir(c, 'approved', notes.value), 'btn btn-chico'),
          boton('Rechazar', async () => decidir(c, 'rejected', notes.value), 'btn btn-sutil btn-chico'));
      } },
    ], pendientes, { vacio: 'No hay documentos pendientes.' }), { pista: 'La decisión queda registrada con el administrador, fecha y observación.' }));
  } catch (err) { avisarError(err, 'No se pudieron cargar las validaciones'); vaciar(zona); }

  async function decidir(c, status, notes) {
    try { await api.verificarCertificacion(c.id, status, notes); aviso(status === 'approved' ? 'Certificación aprobada' : 'Certificación rechazada'); location.hash = '#/validaciones'; }
    catch (err) { avisarError(err, 'No se pudo guardar la validación'); }
  }
}
