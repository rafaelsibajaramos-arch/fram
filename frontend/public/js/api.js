// Cliente del API Gateway. El navegador nunca habla con :3001 ni :3002.

export const sesion = {
  token: sessionStorage.getItem('ftt_token') ?? null,
  userId: sessionStorage.getItem('ftt_user') ?? null,
  roles: JSON.parse(sessionStorage.getItem('ftt_roles') ?? '[]'),

  /**
   * Identidad recordada por rol. Sin esto cada inicio de sesión generaría un
   * user_id nuevo y el perfil de productor creado antes quedaría huérfano.
   */
  identidadRecordada(rol) {
    try {
      return localStorage.getItem(`ftt_uid_${rol}`) ?? undefined;
    } catch {
      return undefined;
    }
  },
  recordarIdentidad(rol, userId) {
    try {
      localStorage.setItem(`ftt_uid_${rol}`, userId);
    } catch {
      /* ventana privada: no se recuerda, no es un problema */
    }
  },

  get activa() {
    return !!this.token;
  },
  get esAdmin() {
    return this.roles.includes('admin');
  },
  guardar({ token, user_id, roles }) {
    this.token = token;
    this.userId = user_id;
    this.roles = roles ?? [];
    sessionStorage.setItem('ftt_token', token);
    sessionStorage.setItem('ftt_user', user_id);
    sessionStorage.setItem('ftt_roles', JSON.stringify(this.roles));
  },
  cerrar() {
    this.token = null;
    this.userId = null;
    this.roles = [];
    sessionStorage.clear();
  },
};

/** Error con el cuerpo que devolvió el microservicio. */
export class ErrorApi extends Error {
  constructor(status, cuerpo, ruta) {
    const detalle = mensajeDe(cuerpo);
    super(detalle || `HTTP ${status}`);
    this.status = status;
    this.cuerpo = cuerpo;
    this.ruta = ruta;
  }
}

function mensajeDe(cuerpo) {
  if (!cuerpo) return '';
  if (typeof cuerpo === 'string') return cuerpo;
  const m = cuerpo.message ?? cuerpo.error;
  return Array.isArray(m) ? m.join(' · ') : (m ?? '');
}

async function pedir(metodo, ruta, cuerpo) {
  const cabeceras = {};
  if (sesion.token) cabeceras.authorization = `Bearer ${sesion.token}`;
  if (cuerpo !== undefined) cabeceras['content-type'] = 'application/json';

  const res = await fetch(ruta, {
    method: metodo,
    headers: cabeceras,
    ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
  });

  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }

  if (!res.ok) throw new ErrorApi(res.status, datos, ruta);
  return datos;
}

const P = (p) => `/api/producer${p}`;
const C = (p) => `/api/catalog${p}`;

export const api = {
  // -------------------------------------------------------------- identidad
  login: (role, user_id) => pedir('POST', '/auth/login', { role, user_id }),

  // ------------------------------------------------------------ productores
  crearProductor: (d) => pedir('POST', P('/producers'), d),
  listarProductores: (q = {}) => pedir('GET', P(`/producers${qs(q)}`)),
  verProductor: (id) => pedir('GET', P(`/producers/${id}`)),
  productorPorUsuario: (userId) => pedir('GET', P(`/producers/by-user/${userId}`)),
  actualizarProductor: (id, d) => pedir('PATCH', P(`/producers/${id}`), d),
  habilitarProductor: (id) => pedir('PATCH', P(`/producers/${id}/enable`)),
  deshabilitarProductor: (id) => pedir('PATCH', P(`/producers/${id}/disable`)),

  // ----------------------------------------------------------------- fincas
  crearFinca: (productorId, d) => pedir('POST', P(`/producers/${productorId}/farms`), d),
  listarFincas: (productorId, q = {}) => pedir('GET', P(`/producers/${productorId}/farms${qs(q)}`)),
  verFinca: (id) => pedir('GET', P(`/farms/${id}`)),
  actualizarFinca: (id, d) => pedir('PATCH', P(`/farms/${id}`), d),
  habilitarFinca: (id) => pedir('PATCH', P(`/farms/${id}/enable`)),
  deshabilitarFinca: (id) => pedir('PATCH', P(`/farms/${id}/disable`)),

  // -------------------------------------------------------- certificaciones
  crearCertificacion: (productorId, d) => pedir('POST', P(`/producers/${productorId}/certifications`), d),
  listarCertificaciones: (productorId, q = {}) =>
    pedir('GET', P(`/producers/${productorId}/certifications${qs(q)}`)),
  actualizarCertificacion: (id, d) => pedir('PATCH', P(`/certifications/${id}`), d),
  revocarCertificacion: (id) => pedir('PATCH', P(`/certifications/${id}/revoke`)),

  // ------------------------------------------------------------- categorías
  crearCategoria: (d) => pedir('POST', C('/categories'), d),
  listarCategorias: () => pedir('GET', C('/categories')),
  actualizarCategoria: (id, d) => pedir('PATCH', C(`/categories/${id}`), d),

  // --------------------------------------------------------------- productos
  crearProducto: (d) => pedir('POST', C('/products'), d),
  listarProductos: (q = {}) => pedir('GET', C(`/products${qs(q)}`)),
  productosDisponibles: (q = {}) => pedir('GET', C(`/products/available${qs(q)}`)),
  verProducto: (id) => pedir('GET', C(`/products/${id}`)),
  actualizarProducto: (id, d) => pedir('PATCH', C(`/products/${id}`), d),
  habilitarProducto: (id) => pedir('PATCH', C(`/products/${id}/enable`)),
  deshabilitarProducto: (id) => pedir('PATCH', C(`/products/${id}/disable`)),

  // ------------------------------------------------------------------ precios
  precioVigente: (id) => pedir('GET', C(`/products/${id}/price`)),
  historialPrecios: (id) => pedir('GET', C(`/products/${id}/prices`)),

  // ------------------------------------------------------------------- lotes
  crearLote: (d) => pedir('POST', C('/harvest-batches'), d),
  listarLotes: (q = {}) => pedir('GET', C(`/harvest-batches${qs(q)}`)),
  verLote: (id) => pedir('GET', C(`/harvest-batches/${id}`)),
  actualizarLote: (id, d) => pedir('PATCH', C(`/harvest-batches/${id}`), d),
  publicarLote: (id) => pedir('PATCH', C(`/harvest-batches/${id}/publish`)),
  cerrarLote: (id) => pedir('PATCH', C(`/harvest-batches/${id}/close`)),

  // ------------------------------------------------------------ simuladores
  simularStock: (d) => pedir('POST', '/api/sim/stock-changed', d),
  simularBajaUsuario: (d) => pedir('POST', '/api/sim/user-disabled', d),

  // ------------------------------------------------------------- diagnóstico
  salud: () => pedir('GET', '/api/system/health'),
  colas: () => pedir('GET', '/api/system/queues'),
};

function qs(obj) {
  const partes = Object.entries(obj).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return partes.length ? `?${new URLSearchParams(partes)}` : '';
}
