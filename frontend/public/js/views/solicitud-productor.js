import { api } from '../api.js';
import { avisarError, aviso, boton, el, entrada, tarjeta, vaciar } from '../ui.js';

export async function vistaSolicitudProductor(raiz) {
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
        )));
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
        zona.append(tarjeta('Solicitud anterior', el('div', { class: 'solicitud-estado' },
          el('span', { class: 'insignia mal' }, 'No aprobada'),
          solicitud.reviewNotes ? el('p', {}, solicitud.reviewNotes) : el('p', {}, 'Puedes enviar una nueva solicitud con información actualizada.'),
        )));
      }
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
    const formulario = el('form', { class: 'form-solicitud-productor' },
      el('label', { class: 'campo' }, el('span', {}, 'Nombre de la finca o negocio'), nombre),
      el('label', { class: 'campo' }, el('span', {}, 'Teléfono'), telefono),
      el('label', { class: 'campo' }, el('span', {}, 'Información para la revisión'), mensaje),
      el('button', { class: 'btn', type: 'submit' }, 'Enviar solicitud'),
    );
    const enviar = formulario.querySelector('button');
    formulario.onsubmit = async (event) => {
      event.preventDefault();
      if (!formulario.reportValidity() || enviar.disabled) return;
      enviar.disabled = true;
      enviar.textContent = 'Enviando…';
      try {
        await api.solicitarPerfilProductor({ business_name: nombre.value.trim(), phone: telefono.value.trim() || undefined, message: mensaje.value.trim() || undefined });
        aviso('Solicitud enviada', 'Quedó pendiente de revisión administrativa.');
        await cargar();
      } catch (error) {
        avisarError(error, 'No se pudo enviar la solicitud');
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
}
