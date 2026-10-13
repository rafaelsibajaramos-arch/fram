import { sesion } from '../api.js';
import { vistaAcceso } from './acceso.js';

/** Vista heredada de registro: se conserva alineada con el registro publico. */
export function vistaRegistro(raiz) {
  vistaAcceso(raiz, true, () => {
    location.hash = sesion.roles.includes('producer') ? '#/productores' : '#/productos';
  });
}
