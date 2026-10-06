import { api } from '../api.js';
import { avisarError, aviso, boton, cargando, el, entrada, tabla, tarjeta, vaciar } from '../ui.js';

/** Administración de perfiles de acceso. Solo se enruta para el rol admin. */
export async function vistaRoles(raiz) {
  raiz.append(
    el('h1', {}, 'Usuarios y roles'),
    el('p', { class: 'subtitulo' }, 'Las cuentas públicas nacen como Comprador. Asigne Productor solo después de la revisión administrativa.'),
  );
  const zona = el('div', {});
  raiz.append(zona);

  const recarga = tarjeta('Recargar TerraWallet', el('div', { class: 'campos' },
    campoAdmin('Correo del comprador', entrada('wallet_email', { type: 'email', placeholder: 'comprador@correo.com' })),
    campoAdmin('Monto (COP)', entrada('wallet_amount', { type: 'number', min: '1', step: '1', placeholder: '50000' })),
    boton('Cargar saldo', async () => {
      const email = recarga.querySelector('[name="wallet_email"]').value.trim();
      const amount = Number(recarga.querySelector('[name="wallet_amount"]').value);
      if (!email || !amount || amount <= 0) return aviso('Completa correo y monto', '', 'mal');
      try {
        const encontrados = await api.listarUsuarios(email);
        const usuario = encontrados.find((u) => u.email.toLowerCase() === email.toLowerCase());
        if (!usuario) throw new Error('No existe un comprador con ese correo');
        await api.recargarBilletera(usuario.id, { amount, reason: 'Recarga administrativa' });
        aviso('Saldo cargado', `${email} · ${amount.toLocaleString('es-CO')} COP`);
        recarga.querySelector('[name="wallet_amount"]').value = '';
      } catch (error) { avisarError(error, 'No se pudo cargar el saldo'); }
    }, 'btn')));
  raiz.insertBefore(recarga, zona);

  async function cargar(search = '') {
    vaciar(zona).append(cargando('Cargando usuarios'));
    try {
      const usuarios = await api.listarUsuarios(search);
      const buscador = entrada('search', { type: 'search', placeholder: 'Buscar por nombre o correo', value: search });
      const buscar = async () => cargar(buscador.value);
      buscador.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); void buscar(); } };
      const cambiarProductor = async (usuario) => {
        const esProductor = usuario.roles.includes('producer');
        const roles = esProductor ? usuario.roles.filter((rol) => rol !== 'producer') : [...usuario.roles, 'producer'];
        try {
          await api.asignarRoles(usuario.id, roles);
          aviso(esProductor ? 'Perfil productor retirado' : 'Perfil productor asignado', usuario.email);
          await cargar(buscador.value);
        } catch (error) { avisarError(error, 'No se pudo actualizar el rol'); }
      };
      const deshabilitar = async (usuario) => {
        if (!confirm(`¿Deshabilitar a ${usuario.email}? Esta acción cerrará sus sesiones.`)) return;
        try { await api.deshabilitarUsuario(usuario.id); aviso('Usuario deshabilitado', usuario.email); await cargar(buscador.value); }
        catch (error) { avisarError(error, 'No se pudo deshabilitar el usuario'); }
      };
      vaciar(zona).append(tarjeta(
        'Cuentas registradas',
        el('div', {},
          el('div', { class: 'acciones', style: 'margin:0 0 14px' }, buscador, boton('Buscar', buscar, 'btn btn-sutil btn-chico')),
          tabla([
            { titulo: 'Usuario', celda: (u) => el('div', {}, el('strong', {}, u.full_name), el('small', { class: 'pista' }, u.email)) },
            { titulo: 'Roles', celda: (u) => el('span', { class: 'mono' }, u.roles.join(', ')) },
            { titulo: 'Estado', celda: (u) => el('span', { class: `insignia ${u.status === 'active' ? 'ok' : 'mal'}` }, u.status === 'active' ? 'Activo' : 'Inactivo') },
            { titulo: 'Acciones', celda: (u) => u.roles.includes('admin') ? el('span', { class: 'pista' }, 'Administrado internamente') : el('div', { class: 'acciones' }, boton(u.roles.includes('producer') ? 'Retirar productor' : 'Asignar productor', () => cambiarProductor(u), u.roles.includes('producer') ? 'btn btn-sutil btn-chico' : 'btn btn-chico'), u.status === 'active' ? boton('Deshabilitar', () => deshabilitar(u), 'btn btn-sutil btn-chico') : el('span', { class: 'pista' }, 'Deshabilitado')) },
          ], usuarios, { vacio: 'No hay usuarios que coincidan con la búsqueda.' }),
          el('p', { class: 'pista', style: 'margin-top:14px' }, 'El cambio invalida la sesión anterior del usuario para que sus permisos se actualicen al volver a iniciar sesión.'),
        ),
      ));
    } catch (error) {
      avisarError(error, 'No se pudieron cargar los usuarios');
      vaciar(zona);
    }
  }
  await cargar();
}

function campoAdmin(label, nodo) { return el('label', { class: 'campo' }, el('span', {}, label), nodo); }
