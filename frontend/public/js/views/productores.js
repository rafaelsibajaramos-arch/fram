// Vista de Productores: perfil, fincas y certificaciones.

import { api, sesion } from '../api.js';
import { estado } from '../state.js';
import { contextoProductor } from '../campos.js';
import { selectorUbicacion } from '../geo.js';
import {
  avisarError, aviso, boton, campo, cargando, chipId, el, entrada, fmtFecha,
  faltanDatos, insignia, insigniaBool, pie, seleccion, tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaProductores(raiz) {
  raiz.append(
    el('h1', {}, 'Productores'),
    el('p', { class: 'subtitulo' },
      'producer-service es dueño de los productores, sus fincas y sus certificaciones. ' +
      'Nada se borra: todo se desactiva con baja lógica.'),
  );

  const zonaLista = el('div', {});
  const zonaDetalle = el('div', {});

  const ctx = await contextoProductor();
  // Un productor solo puede tener un perfil: si ya lo tiene, se abre el suyo
  // en vez de ofrecerle crear otro.
  if (!ctx.esAdmin && ctx.propio) {
    estado.fijar({ productorId: ctx.propio.id });
  } else {
    raiz.append(formularioCrear(ctx, async () => {
      if (ctx.esAdmin) return refrescarLista();
      const propio = await api.productorPorUsuario(sesion.userId);
      estado.fijar({ productorId: propio.id });
      return refrescarDetalle();
    }));
  }

  // El registro y su contador pertenecen al panel administrativo. Un
  // productor trabaja solamente sobre su perfil, fincas y certificaciones.
  if (ctx.esAdmin) raiz.append(zonaLista);
  raiz.append(zonaDetalle);

  async function refrescarLista() {
    vaciar(zonaLista).append(cargando());
    try {
      const filtros = valores(cajaFiltros);
      const r = await api.listarProductores({ ...filtros, limit: 50 });
      vaciar(zonaLista).append(
        tarjeta(
          `Registrados (${r.meta.total})`,
          tabla(
            [
              { titulo: 'ID', celda: (p) => chipId(p.id) },
              { titulo: 'Nombre', celda: (p) => p.full_name },
              { titulo: 'Email', celda: (p) => p.email },
              { titulo: 'Teléfono', celda: (p) => p.phone ?? '—' },
              { titulo: 'Estado', celda: (p) => insignia(p.status) },
              { titulo: 'Alta', celda: (p) => fmtFecha(p.created_at) },
            ],
            r.data,
            {
              alElegir: (p) => { estado.fijar({ productorId: p.id }); refrescarLista(); refrescarDetalle(); },
              elegida: (p) => p.id === estado.productorId,
              vacio: 'Todavía no hay productores. Cree uno arriba.',
            },
          ),
          { accion: cajaFiltros, pista: 'Pulse una fila para ver sus fincas y certificaciones.' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudo listar');
      vaciar(zonaLista).append(tarjeta('Registrados', el('div', { class: 'vacio' }, 'Error al cargar')));
    }
  }

  const cajaFiltros = el(
    'div',
    { class: 'acciones' },
    seleccion('status', [['', 'Todos'], ['active', 'Activos'], ['disabled', 'Inactivos']], {
      onchange: () => refrescarLista(),
      style: 'padding:5px 8px;font-size:13px',
    }),
    entrada('search', {
      placeholder: 'Buscar nombre o email',
      style: 'padding:5px 8px;font-size:13px;width:180px',
      onkeydown: (e) => { if (e.key === 'Enter') refrescarLista(); },
    }),
  );

  async function refrescarDetalle() {
    vaciar(zonaDetalle);
    if (!estado.productorId) return;
    vaciar(zonaDetalle).append(cargando('Cargando productor…'));
    try {
      const p = await api.verProductor(estado.productorId);
      vaciar(zonaDetalle).append(
        panelProductor(p, refrescarLista, refrescarDetalle),
        el('div', { class: 'rejilla' }, await panelFincas(p), await panelCertificaciones(p)),
      );
    } catch (err) {
      avisarError(err, 'No se pudo abrir el productor');
      estado.fijar({ productorId: null });
      vaciar(zonaDetalle);
    }
  }

  if (ctx.esAdmin) await refrescarLista();
  await refrescarDetalle();
}

// ------------------------------------------------------------------- crear

function formularioCrear(ctx, alCrear) {
  // El user_id no es un dato que el usuario deba escribir: es el sub de su JWT.
  // Solo un admin necesita indicar otra cuenta.
  const caja = el(
    'div',
    { class: 'campos' },
    ctx.esAdmin
      ? campo('Cuenta de Identidad', entrada('user_id', { placeholder: 'UUID de la cuenta' }),
          'Vacío = se crea para su propia cuenta')
      : entrada('user_id', { type: 'hidden', value: sesion.userId ?? '' }),
    campo('Nombre completo', entrada('full_name', { placeholder: 'Juan Pérez' })),
    campo('Email de contacto', entrada('email', { type: 'email', placeholder: 'juan@example.com' }),
      'Se normaliza a minúsculas; es único'),
    campo('Teléfono', entrada('phone', { placeholder: '3000000000' }), 'Opcional'),
  );

  const btn = boton(ctx.esAdmin ? 'Crear perfil' : 'Guardar mi perfil', async () => {
    const datos = valores(caja);
    datos.user_id ??= sesion.userId;
    if (faltanDatos([[datos.full_name, 'nombre completo'], [datos.email, 'email']])) return;

    btn.disabled = true;
    try {
      const p = await api.crearProductor(datos);
      aviso(ctx.esAdmin ? 'Perfil de productor creado' : 'Tu perfil de productor está listo', p.full_name);
      estado.fijar({ productorId: p.id });
      caja.querySelector('[name=full_name]').value = '';
      caja.querySelector('[name=email]').value = '';
      caja.querySelector('[name=phone]').value = '';
      await alCrear();
      location.hash = '#/productores';
    } catch (err) {
      avisarError(err, 'No se pudo crear el productor');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  return tarjeta(ctx.esAdmin ? 'Crear perfil de productor' : 'Completa tu perfil de productor', el('div', {}, caja, pie(btn)), {
    pista: ctx.esAdmin
      ? 'POST /producers — el perfil se publica con producer.created a través del outbox.'
      : 'Este perfil queda asociado únicamente a su cuenta. No crea otra cuenta ni otro usuario.',
  });
}

// ------------------------------------------------------------------ perfil

function panelProductor(p, refrescarLista, refrescarDetalle) {
  const caja = el(
    'div',
    { class: 'campos' },
    campo('Nombre', entrada('full_name', { value: p.full_name })),
    campo('Email', entrada('email', { value: p.email })),
    campo('Teléfono', entrada('phone', { value: p.phone ?? '' })),
  );

  const guardar = boton('Guardar cambios', async () => {
    try {
      await api.actualizarProductor(p.id, valores(caja));
      aviso('Productor actualizado', 'Se publicó producer.updated');
      await refrescarLista();
      await refrescarDetalle();
    } catch (err) {
      avisarError(err, 'No se pudo actualizar');
    }
  }, 'btn btn-sec');

  const alternar = boton(
    p.status === 'active' ? 'Desactivar' : 'Reactivar',
    async () => {
      try {
        if (p.status === 'active') {
          await api.deshabilitarProductor(p.id);
          aviso('Productor desactivado', 'Catálogo retirará sus productos al recibir producer.disabled');
        } else {
          await api.habilitarProductor(p.id);
          aviso('Productor reactivado', 'Operación administrativa');
        }
        await refrescarLista();
        await refrescarDetalle();
      } catch (err) {
        avisarError(err, 'No se pudo cambiar el estado');
      }
    },
    p.status === 'active' ? 'btn btn-peligro' : 'btn btn-sec',
  );

  return tarjeta(
    sesion.esAdmin ? p.full_name : 'Mi perfil',
    el('div', {}, caja, pie(guardar, alternar)),
    {
      accion: el('div', { class: 'acciones' }, insignia(p.status), chipId(p.id)),
      pista: p.status === 'active'
        ? (sesion.esAdmin ? 'Perfil del productor seleccionado.' : 'Información del propietario y sus datos de contacto.')
        : 'Está dado de baja lógicamente: el registro sigue existiendo.',
    },
  );
}

// ------------------------------------------------------------------ fincas

async function panelFincas(p) {
  const zona = el('div', {});

  const caja = el(
    'div',
    { class: 'campos' },
    campo('Nombre', entrada('farm_name', { placeholder: 'Finca La Esperanza' })),
    campo('Dirección de recogida', entrada('address', { placeholder: 'Vereda El Rosario' })),
    campo('Latitud', entrada('latitude', { type: 'number', step: '0.000001', placeholder: '8.757' }), '-90 a 90'),
    campo('Longitud', entrada('longitude', { type: 'number', step: '0.000001', placeholder: '-75.89' }), '-180 a 180'),
  );

  const address = caja.querySelector('[name=address]');
  const latitude = caja.querySelector('[name=latitude]');
  const longitude = caja.querySelector('[name=longitude]');
  caja.append(await selectorUbicacion({ address, latitude, longitude }));

  const btn = boton('Añadir finca', async () => {
    btn.disabled = true;
    try {
      const f = await api.crearFinca(p.id, valores(caja));
      aviso('Finca creada', f.farm_name);
      caja.querySelectorAll('input').forEach((i) => (i.value = ''));
      await refrescar();
    } catch (err) {
      avisarError(err, 'No se pudo crear la finca');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  async function refrescar() {
    vaciar(zona).append(cargando());
    try {
      const fincas = await api.listarFincas(p.id);
      vaciar(zona).append(
        tabla(
          [
            { titulo: 'Finca', celda: (f) => f.farm_name },
            { titulo: 'Coordenadas', celda: (f) => el('span', { class: 'mono' }, `${f.latitude}, ${f.longitude}`) },
            { titulo: 'Estado', celda: (f) => insigniaBool(f.active) },
            {
              titulo: '',
              celda: (f) =>
                boton(
                  f.active ? 'Desactivar' : 'Activar',
                  async () => {
                    try {
                      f.active ? await api.deshabilitarFinca(f.id) : await api.habilitarFinca(f.id);
                      aviso('Finca actualizada', f.farm_name);
                      await refrescar();
                    } catch (err) {
                      avisarError(err, 'No se pudo cambiar la finca');
                    }
                  },
                  'btn btn-sutil btn-chico',
                ),
            },
            { titulo: 'ID', celda: (f) => chipId(f.id) },
          ],
          fincas,
          { vacio: 'Sin fincas todavía' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudieron listar las fincas');
      vaciar(zona);
    }
  }

  await refrescar();

  return tarjeta('Fincas', el('div', {}, zona, el('div', { style: 'margin-top:18px' }, caja), pie(btn)), {
    pista: 'Una finca pertenece a un único productor. El catálogo la valida por REST antes de aceptar un lote.',
  });
}

// --------------------------------------------------------- certificaciones

async function panelCertificaciones(p) {
  const zona = el('div', {});
  const archivo = el('input', {
    type: 'file',
    accept: '.pdf,image/jpeg,image/png,image/webp',
    class: 'archivo-cert',
  });

  const caja = el(
    'div',
    { class: 'campos' },
    campo('Documento', archivo, 'Opcional. PDF, JPG, PNG o WEBP; queda pendiente de validacion administrativa.'),
    campo('Tipo', entrada('type', { placeholder: 'Orgánica' })),
    campo('Expedición', entrada('issue_date', { type: 'date' })),
    campo('Vencimiento', entrada('valid_until', { type: 'date' }), 'Vacío = sin caducidad'),
  );

  const btn = boton('Añadir certificación', async () => {
    btn.disabled = true;
    try {
      const c = await api.crearCertificacion(p.id, valores(caja));
      const seleccionado = archivo.files?.[0];
      if (seleccionado) {
        try {
          await api.subirArchivoCertificacion(c.id, seleccionado);
          aviso('Certificacion creada', 'Documento cargado y pendiente de validacion administrativa');
        } catch (err) {
          aviso('Certificacion creada', 'El registro existe, pero no se pudo cargar el documento');
          avisarError(err, 'No se pudo cargar el documento');
        }
      }
      aviso('Certificación creada', c.type);
      caja.querySelectorAll('input').forEach((i) => (i.value = ''));
      await refrescar();
    } catch (err) {
      avisarError(err, 'No se pudo crear la certificación');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  async function refrescar() {
    vaciar(zona).append(cargando());
    try {
      const certs = await api.listarCertificaciones(p.id);
      vaciar(zona).append(
        tabla(
          [
            { titulo: 'Tipo', celda: (c) => c.type },
            { titulo: 'Expedición', celda: (c) => c.issue_date },
            { titulo: 'Vence', celda: (c) => c.valid_until ?? 'nunca' },
            { titulo: 'Estado', celda: (c) => insignia(c.status) },
            { titulo: 'Verificación', celda: (c) => insignia(c.verification?.status ?? 'pending') },
            {
              titulo: 'Documento',
              celda: (c) => {
                const input = el('input', { type: 'file', accept: '.pdf,image/jpeg,image/png,image/webp', class: 'archivo-cert' });
                input.addEventListener('change', async () => {
                  if (!input.files?.[0]) return;
                  try { await api.subirArchivoCertificacion(c.id, input.files[0]); aviso('Documento cargado', 'Quedó pendiente de validación administrativa'); await refrescar(); }
                  catch (err) { avisarError(err, 'No se pudo cargar el documento'); }
                });
                const abrirDocumento = c.file
                  ? boton(c.file.name, async () => {
                      try { await api.abrirArchivoCertificacion(c.id, c.file.name); }
                      catch (err) { avisarError(err, 'No se pudo abrir el documento'); }
                    }, 'btn btn-sutil btn-chico')
                  : null;
                return c.file ? el('div', { class: 'cert-file' }, abrirDocumento, input) : input;
              },
            },
            { titulo: 'Vigente', celda: (c) => insigniaBool(c.is_current, 'sí', 'no') },
            {
              titulo: '',
              celda: (c) =>
                c.status === 'revoked'
                  ? ''
                  : boton(
                      'Revocar',
                      async () => {
                        try {
                          await api.revocarCertificacion(c.id);
                          aviso('Certificación revocada', 'El registro se conserva en el historial');
                          await refrescar();
                        } catch (err) {
                          avisarError(err, 'No se pudo revocar');
                        }
                      },
                      'btn btn-sutil btn-chico',
                    ),
            },
          ],
          certs,
          { vacio: 'Sin certificaciones' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudieron listar las certificaciones');
      vaciar(zona);
    }
  }

  await refrescar();

  return tarjeta('Certificaciones', el('div', {}, zona, el('div', { style: 'margin-top:18px' }, caja), pie(btn)), {
    pista: 'Pertenecen al productor y no certifican automáticamente cada finca.',
  });
}
