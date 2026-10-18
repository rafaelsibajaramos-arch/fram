import { api } from '../api.js';
import { avisarError, aviso, boton, cargando, el, fmtFecha, insignia, tarjeta, vaciar } from '../ui.js';

export async function vistaSolicitudesProductor(raiz) {
  raiz.append(el('h1', {}, 'Solicitudes de productor'), el('p', { class: 'subtitulo' }, 'Revisa las cuentas que desean vender en FarmToTable. Aprobar habilita el rol y cierra sus sesiones anteriores para renovar permisos.'));
  const zona = el('div', {});
  raiz.append(zona);
  await cargar();

  async function cargar() {
    vaciar(zona).append(cargando('Cargando solicitudes'));
    try {
      const solicitudes = await api.listarSolicitudesProductor();
      const pendientes = solicitudes.filter((solicitud) => solicitud.status === 'pending').length;
      const resumen = el('div', { class: 'solicitudes-resumen' },
        el('span', { class: 'solicitudes-cifra' }, String(pendientes)),
        el('div', {}, el('strong', {}, pendientes === 1 ? 'Solicitud pendiente' : 'Solicitudes pendientes'), el('small', { class: 'pista' }, `${solicitudes.length} en total`)),
        boton('Actualizar', cargar, 'btn btn-sutil btn-chico'),
      );
      const filas = solicitudes.map((solicitud) => {
        const persona = solicitud.applicant ?? {};
        const acciones = solicitud.status === 'pending'
          ? el('div', { class: 'acciones' },
            boton('Aprobar', () => revisar(solicitud, 'approved'), 'btn btn-chico'),
            boton('Rechazar', () => revisar(solicitud, 'rejected'), 'btn btn-sutil btn-chico'),
          )
          : el('span', { class: 'pista' }, solicitud.reviewer?.fullName ? `Revisó ${solicitud.reviewer.fullName}` : 'Revisada');
        return el('article', { class: `solicitud-productor-card ${solicitud.status === 'pending' ? 'pendiente' : ''}` },
          el('div', { class: 'solicitud-productor-cabecera' },
            el('div', {}, el('span', { class: 'solicitud-etiqueta' }, solicitud.status === 'pending' ? 'REQUIERE REVISIÓN' : 'SOLICITUD'), el('h2', {}, solicitud.businessName), el('p', {}, persona.fullName ?? 'Cuenta sin nombre', ' · ', persona.email ?? 'Correo no disponible')),
            insignia(solicitud.status),
          ),
          solicitud.phone ? el('p', {}, el('strong', {}, 'Teléfono: '), solicitud.phone) : null,
          solicitud.message ? el('p', { class: 'solicitud-mensaje' }, solicitud.message) : el('p', { class: 'pista' }, 'No incluyó información adicional.'),
          solicitud.reviewNotes ? el('p', { class: 'pista' }, `Nota de revisión: ${solicitud.reviewNotes}`) : null,
          el('div', { class: 'solicitud-productor-pie' }, el('small', { class: 'pista' }, `${fmtFecha(solicitud.createdAt)}${solicitud.reviewedAt ? ` · Revisada ${fmtFecha(solicitud.reviewedAt)}` : ''}`), acciones),
        );
      });
      vaciar(zona).append(tarjeta('Bandeja de revisión', el('div', {}, resumen, filas.length ? el('div', { class: 'solicitudes-productor-lista' }, filas) : el('div', { class: 'vacio' }, 'Aún no hay solicitudes de productor.'))));
    } catch (error) {
      vaciar(zona).append(el('p', {}, 'No se pudieron cargar las solicitudes.'), boton('Reintentar', cargar, 'btn btn-sutil'));
      avisarError(error, 'No se pudieron cargar las solicitudes');
    }
  }

  async function revisar(solicitud, decision) {
    const accion = decision === 'approved' ? 'aprobar' : 'rechazar';
    if (!confirm(`¿Confirmas ${accion} la solicitud de ${solicitud.applicant?.fullName ?? solicitud.businessName}?`)) return;
    const review_notes = prompt(decision === 'approved' ? 'Nota para la persona (opcional):' : 'Motivo del rechazo (recomendado):', '') ?? null;
    if (review_notes === null) return;
    try {
      await api.revisarSolicitudProductor(solicitud.id, decision, review_notes);
      aviso(decision === 'approved' ? 'Productor habilitado' : 'Solicitud rechazada', `${solicitud.applicant?.fullName ?? solicitud.businessName}. La persona deberá volver a iniciar sesión.`);
      await cargar();
    } catch (error) { avisarError(error, `No se pudo ${accion} la solicitud`); }
  }
}
