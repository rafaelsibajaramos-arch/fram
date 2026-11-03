import { api } from '../api.js';
import { avisarError, aviso, boton, el, entrada, tarjeta, vaciar } from '../ui.js';

export async function vistaSolicitudProductor(raiz) {
  vaciar(raiz);
  raiz.append(
    el('h1', {}, 'Vende en FarmToTable'),
    el('p', { class: 'subtitulo' }, 'Cuéntanos sobre tu unidad productiva. El equipo revisará la solicitud antes de habilitar las herramientas para productores.'),
  );
  const zona = el('div', {});
  raiz.append(zona);
  await cargar();

  async function cargar() {
    vaciar(zona).append(el('p', { class: 'pista' }, 'Consultando el estado de tu solicitud…'));
    try {
      const solicitud = await api.miSolicitudProductor();
      if (solicitud?.status === 'pending') {
        vaciar(zona).append(tarjeta('Solicitud en revisión', el('div', { class: 'solicitud-estado' },
          el('span', { class: 'insignia aviso' }, 'En revisión'),
          el('h2', {}, solicitud.businessName),
          el('p', {}, 'Te avisaremos cuando el equipo termine la revisión. Puedes seguir comprando mientras tanto.'),
          solicitud.message ? el('blockquote', {}, solicitud.message) : null,
          el('small', { class: 'pista' }, `Enviada ${new Date(solicitud.createdAt).toLocaleDateString('es-CO')}`),
        )), tarjeta('Documentos para la revisión', documentos(solicitud)));
        return;
      }
      if (solicitud?.status === 'approved') {
        vaciar(zona).append(tarjeta('Solicitud aprobada', el('div', { class: 'solicitud-estado' },
          el('span', { class: 'insignia ok' }, 'Aprobada'),
          el('h2', {}, solicitud.businessName),
          el('p', {}, 'Tu cuenta ya tiene permisos de productor. Cierra sesión e inicia de nuevo para acceder a las herramientas de tu finca y catálogo.'),
          solicitud.reviewNotes ? el('p', { class: 'pista' }, `Nota: ${solicitud.reviewNotes}`) : null,
        )));
        return;
      }
      if (solicitud?.status === 'rejected') {
        vaciar(zona);
        zona.append(tarjeta('Solicitud anterior', el('div', { class: 'solicitud-estado' },
          el('span', { class: 'insignia mal' }, 'No aprobada'),
          solicitud.reviewNotes ? el('p', {}, solicitud.reviewNotes) : el('p', {}, 'Puedes enviar una nueva solicitud con información actualizada.'),
        )));
      }
      if (!solicitud) vaciar(zona);
      mostrarFormulario();
    } catch (error) {
      vaciar(zona).append(el('p', {}, 'No pudimos consultar tu solicitud.'), boton('Reintentar', cargar, 'btn btn-sutil'));
      avisarError(error, 'No se pudo cargar el estado de la solicitud');
    }
  }

  function mostrarFormulario() {
    const nombre = entrada('text', { name: 'business_name', required: true, maxLength: 150, placeholder: 'Ej. Finca La Esperanza' });
    const telefono = entrada('tel', { name: 'phone', maxLength: 25, placeholder: 'Teléfono de contacto (opcional)' });
    const mensaje = el('textarea', { name: 'message', rows: 4, maxLength: 1000, placeholder: 'Cuéntanos qué cultivas, dónde está tu finca y cómo planeas ofrecer tus productos (opcional).' });
    const frente = entrada('cedula_frente', { type: 'file', accept: '.jpg,.jpeg,.png', required: true });
    const reverso = entrada('cedula_reverso', { type: 'file', accept: '.jpg,.jpeg,.png', required: true });
    const certificado = entrada('certificacion', { type: 'file', accept: '.jpg,.jpeg,.png,.pdf', required: true });
    const formulario = el('form', { class: 'form-solicitud-productor' },
      el('label', { class: 'campo' }, el('span', {}, 'Nombre de la finca o negocio'), nombre),
      el('label', { class: 'campo' }, el('span', {}, 'Teléfono'), telefono),
      el('label', { class: 'campo' }, el('span', {}, 'Información para la revisión'), mensaje),
      el('h3', {}, 'Documentos para la revisión'),
      el('p', { class: 'pista' }, 'Archivos JPG, PNG o PDF de máximo 5 MB. La cédula debe ser una foto JPG o PNG.'),
      el('label', { class: 'campo' }, el('span', {}, 'Cédula · frente'), frente),
      el('label', { class: 'campo' }, el('span', {}, 'Cédula · reverso'), reverso),
      el('label', { class: 'campo' }, el('span', {}, 'Certificación'), certificado),
      el('button', { class: 'btn', type: 'submit' }, 'Enviar solicitud'),
    );
    const enviar = formulario.querySelector('button');
    formulario.onsubmit = async (event) => {
      event.preventDefault();
      if (!formulario.reportValidity() || enviar.disabled) return;
      if ([frente, reverso, certificado].some(control => control.files[0].size > 5 * 1024 * 1024)) { aviso('Cada archivo debe pesar máximo 5 MB', '', 'mal'); return; }
      enviar.disabled = true;
      enviar.textContent = 'Enviando…';
      try {
        const solicitud = await api.solicitarPerfilProductor({ business_name: nombre.value.trim(), phone: telefono.value.trim() || undefined, message: mensaje.value.trim() || undefined });
        for (const [kind, file] of [['cedula_frente', frente.files[0]], ['cedula_reverso', reverso.files[0]], ['certificacion', certificado.files[0]]]) await api.subirDocumentoSolicitud(solicitud.id, kind, file);
        aviso('Solicitud enviada', 'Quedó pendiente de revisión administrativa.');
        await cargar();
      } catch (error) {
        avisarError(error, 'No se pudo enviar la solicitud');
        await cargar();
      } finally {
        enviar.disabled = false;
        enviar.textContent = 'Enviar solicitud';
      }
    };
    zona.append(tarjeta('Solicitud de productor', el('div', {},
      el('p', { class: 'pista' }, 'La solicitud no activa permisos automáticamente. Administración validará la información y aprobará el acceso.'),
      formulario,
    )));
  }

  function documentos(solicitud) {
    const existing = solicitud.documents ?? [];
    const list = el('div', { class: 'solicitudes-productor-lista' });
    const names = { cedula_frente: 'Cédula · frente', cedula_reverso: 'Cédula · reverso', certificacion: 'Certificación' };
    for (const doc of existing) list.append(el('p', {}, `${names[doc.kind] ?? doc.kind}: ${doc.fileName}`));
    const pending = ['cedula_frente', 'cedula_reverso', 'certificacion'].filter(kind => !existing.some(doc => doc.kind === kind));
    const kind = el('select', { class: 'input' }, ['cedula_frente', 'cedula_reverso', 'certificacion'].map(value => el('option', { value }, names[value])));
    if (pending.length) kind.value = pending[0];
    const file = entrada('documento', { type: 'file', accept: '.jpg,.jpeg,.png,.pdf', required: true });
    kind.addEventListener('change', () => { file.accept = kind.value === 'certificacion' ? '.jpg,.jpeg,.png,.pdf' : '.jpg,.jpeg,.png'; file.value = ''; });
    const submit = el('button', { class: 'btn', type: 'submit' }, 'Adjuntar documento');
    const form = el('form', { class: 'form-solicitud-productor', onsubmit: async event => {
      event.preventDefault();
      if (!file.files?.[0] || file.files[0].size > 5 * 1024 * 1024) { aviso('El archivo debe pesar máximo 5 MB', '', 'mal'); return; }
      submit.disabled = true;
      try { await api.subirDocumentoSolicitud(solicitud.id, kind.value, file.files[0]); aviso('Documento adjuntado'); await cargar(); }
      catch (error) { avisarError(error, 'No se pudo adjuntar el documento'); }
      finally { submit.disabled = false; }
    } }, el('label', { class: 'campo' }, el('span', {}, 'Tipo de documento'), kind), el('label', { class: 'campo' }, el('span', {}, 'Foto o archivo'), file), submit);
    return el('div', {}, el('p', { class: 'pista' }, pending.length ? 'Adjunta ambas caras de la cédula y al menos una certificación.' : 'Los documentos requeridos ya están cargados.'), list, form);
  }
}
