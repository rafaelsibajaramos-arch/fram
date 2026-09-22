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
      vaciar(zona).append(tarjeta(
        'Cuentas registradas',
        el('div', {},
          el('div', { class: 'acciones', style: 'margin:0 0 14px' }, buscador, boton('Buscar', buscar, 'btn btn-sutil btn-chico')),
          tabla([
            { titulo: 'Usuario', celda: (u) => el('div', {}, el('strong', {}, u.full_name), el('small', { class: 'pista' }, u.email)) },
            { titulo: 'Roles', celda: (u) => el('span', { class: 'mono' }, u.roles.join(', ')) },
            { titulo: 'Estado', celda: (u) => el('span', { class: `insignia ${u.status === 'active' ? 'ok' : 'mal'}` }, u.status === 'active' ? 'Activo' : 'Inactivo') },
            { titulo: 'Acción', celda: (u) => u.roles.includes('admin') ? el('span', { class: 'pista' }, 'Administrado internamente') : boton(u.roles.includes('producer') ? 'Retirar productor' : 'Asignar productor', () => cambiarProductor(u), u.roles.includes('producer') ? 'btn btn-sutil btn-chico' : 'btn btn-chico') },
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
