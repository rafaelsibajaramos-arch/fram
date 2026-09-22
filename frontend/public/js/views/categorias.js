// Vista de Categorías del catálogo.

import { api } from '../api.js';
import {
  avisarError, aviso, boton, campo, cargando, chipId, el, entrada,
  faltanDatos, insigniaBool, pie, tabla, tarjeta, vaciar, valores,
} from '../ui.js';

export async function vistaCategorias(raiz) {
  raiz.append(
    el('h1', {}, 'Categorías'),
    el('p', { class: 'subtitulo' },
      'Agrupan los productos del catálogo. El nombre es único: se normalizan los espacios y ' +
      'no se distingue entre mayúsculas y minúsculas.'),
  );

  const zona = el('div', {});

  const caja = el('div', { class: 'campos' }, campo('Nombre', entrada('name', { placeholder: 'Frutas' })));
  const btn = boton('Crear categoría', async () => {
    const datos = valores(caja);
    if (faltanDatos([[datos.name, 'nombre']])) return;

    btn.disabled = true;
    try {
      const c = await api.crearCategoria(datos);
      aviso('Categoría creada', c.name);
      caja.querySelector('input').value = '';
      await refrescar();
    } catch (err) {
      avisarError(err, 'No se pudo crear la categoría');
    } finally {
      btn.disabled = false;
    }
  }, 'btn', 'mas');

  raiz.append(
    tarjeta('Nueva categoría', el('div', {}, caja, pie(btn)), {
      pista: 'Intente crear dos veces el mismo nombre: la segunda responde 409 Conflict.',
    }),
    zona,
  );

  async function refrescar() {
    vaciar(zona).append(cargando());
    try {
      const cats = await api.listarCategorias();
      vaciar(zona).append(
        tarjeta(
          `Existentes (${cats.length})`,
          tabla(
            [
              { titulo: 'Nombre', celda: (c) => c.name },
              { titulo: 'Estado', celda: (c) => insigniaBool(c.active) },
              {
                titulo: '',
                celda: (c) =>
                  boton(
                    c.active ? 'Desactivar' : 'Activar',
                    async () => {
                      try {
                        await api.actualizarCategoria(c.id, { active: !c.active });
                        aviso('Categoría actualizada', c.name);
                        await refrescar();
                      } catch (err) {
                        avisarError(err, 'No se pudo actualizar');
                      }
                    },
                    'btn btn-sutil btn-chico',
                  ),
              },
              { titulo: 'ID', celda: (c) => chipId(c.id) },
            ],
            cats,
            { vacio: 'Sin categorías todavía' },
          ),
          { pista: 'Una categoría desactivada no admite productos nuevos ni reactivar los existentes.' },
        ),
      );
    } catch (err) {
      avisarError(err, 'No se pudieron listar las categorías');
      vaciar(zona);
    }
  }

  await refrescar();
}
