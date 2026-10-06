// Cliente del API Gateway. El navegador nunca habla con :3001 ni :3002.

export const sesion = {
  token: sessionStorage.getItem('ftt_token') ?? null,
  refreshToken: sessionStorage.getItem('ftt_refresh') ?? null,
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
  guardar({ token, user_id, roles, refresh_token }) {
    this.token = token;
    this.userId = user_id;
    this.roles = roles ?? [];
    this.refreshToken = refresh_token ?? this.refreshToken;
    sessionStorage.setItem('ftt_token', token);
    sessionStorage.setItem('ftt_user', user_id);
    sessionStorage.setItem('ftt_roles', JSON.stringify(this.roles));
    if (this.refreshToken) sessionStorage.setItem('ftt_refresh', this.refreshToken);
  },
  cerrar() {
    this.token = null;
    this.userId = null;
    this.roles = [];
    this.refreshToken = null;
    for (const key of ['ftt_token', 'ftt_refresh', 'ftt_user', 'ftt_roles']) sessionStorage.removeItem(key);
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
  const operationId = cuerpo?.operation_id ?? cuerpo?.idempotencyKey ?? (metodo !== 'GET' && metodo !== 'HEAD' ? crypto.randomUUID() : null);
  if (sesion.token) cabeceras.authorization = `Bearer ${sesion.token}`;
  if (operationId) cabeceras['Idempotency-Key'] = operationId;
  if (cuerpo !== undefined) cabeceras['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(ruta, {
      method: metodo,
      headers: cabeceras,
      ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('La operación tardó demasiado. Verifica tus pedidos antes de reintentar.');
    throw error;
  }

  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }

  if (res.status === 401 && sesion.activa && !ruta.endsWith('/auth/login')) {
    sesion.cerrar(); dispatchEvent(new Event('ftt:expired'));
  }
  if (!res.ok) throw new ErrorApi(res.status, datos, ruta);
  return datos;
}

const P = (p) => `/api/v1/producer${p}`;
const C = (p) => `/api/v1/catalog${p}`;
const I = (p) => `/api/v1/inventory${p}`;
const ID = (p) => `/api/v1/identity${p}`;
const O = (p) => `/api/v1/orders${p}`;
const PAY = (p) => `/api/v1/payments${p}`;

export const api = {
  // -------------------------------------------------------------- identidad
  login: (role, user_id) => pedir('POST', '/auth/login', { role, user_id }),
  registrar: (d) => pedir('POST', ID('/auth/register'), d),
  verificarCorreo: (token) => pedir('POST', ID('/auth/email/verify'), { token }),
  solicitarRecuperacion: (email) => pedir('POST', ID('/auth/password/reset/request'), { email }),
  confirmarRecuperacion: (token, password) => pedir('POST', ID('/auth/password/reset/confirm'), { token, password }),
  miCuenta: () => pedir('GET', ID('/auth/me')),
  listarUsuarios: (search = '') => pedir('GET', ID(`/auth/users${qs({ search })}`)),
  asignarRoles: (id, roles) => pedir('PATCH', ID(`/auth/users/${id}/roles`), { roles }),
  deshabilitarUsuario: (id) => pedir('PATCH', ID(`/auth/users/${id}/disable`)),
  autenticar: async (email, password) => {
    const r = await pedir('POST', ID('/auth/login'), { email, password });
    return { token: r.access_token, refresh_token: r.refresh_token, user_id: r.user.id, roles: r.user.roles, user: r.user };
  },
  renovar: async () => { const r = await pedir('POST', ID('/auth/refresh'), { refresh_token: sesion.refreshToken }); return { token: r.access_token, refresh_token: r.refresh_token, user_id: r.user.id, roles: r.user.roles, user: r.user }; },
  cerrarSesion: () => sesion.refreshToken ? pedir('POST', ID('/auth/logout'), { refresh_token: sesion.refreshToken }) : Promise.resolve(),

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
  subirArchivoCertificacion: async (id, archivo) => {
    const form = new FormData(); form.append('file', archivo);
    const headers = sesion.token ? { authorization: `Bearer ${sesion.token}` } : {};
    headers['Idempotency-Key'] = crypto.randomUUID();
    const r = await fetch(`/api/v1/producer/certifications/${id}/file`, { method: 'POST', body: form, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErrorApi(r.status, data, `/api/v1/producer/certifications/${id}/file`);
    return data;
  },
  abrirArchivoCertificacion: async (id, nombre = 'certificacion') => {
    const ruta = `/api/v1/producer/certifications/${id}/file`;
    // El archivo esta protegido por JWT. Se abre una pestaña vacia primero para
    // conservar el gesto del usuario y luego se navega al Blob autenticado.
    const ventana = window.open('', '_blank');
    try {
      const headers = sesion.token ? { authorization: `Bearer ${sesion.token}` } : {};
      const res = await fetch(ruta, { headers });
      if (!res.ok) {
        const texto = await res.text();
        let datos = texto;
        try { datos = texto ? JSON.parse(texto) : null; } catch { /* texto no JSON */ }
        throw new ErrorApi(res.status, datos, ruta);
      }

      const url = URL.createObjectURL(await res.blob());
      if (ventana) ventana.location.replace(url);
      else {
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombre;
        enlace.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      ventana?.close();
      throw error;
    }
  },
  certificacionesPendientes: () => pedir('GET', P('/certifications/pending/review')),
  verificarCertificacion: (id, status, notes) => pedir('PATCH', P(`/certifications/${id}/verification`), { status, notes }),

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

  // ------------------------------------------------------------- inventario
  inventarioProducto: (productId) => pedir('GET', I(`/inventory/products/${productId}`)),
  reservarInventario: (d) => pedir('POST', I('/inventory/reservations'), d),
  liberarReserva: (id) => pedir('POST', I(`/inventory/reservations/${id}/release`)),
  consumirReserva: (id) => pedir('POST', I(`/inventory/reservations/${id}/consume`)),

  // --------------------------------------------------------------- pedidos
  verCarrito: (buyerId) => pedir('GET', O(`/cart/${buyerId}`)),
  guardarCarrito: (buyerId, d) => pedir('PUT', O(`/cart/${buyerId}`), d),
  vaciarCarrito: (buyerId) => pedir('DELETE', O(`/cart/${buyerId}`)),
  crearPedido: (d) => pedir('POST', O('/'), d),
  confirmarCheckout: (d) => pedir('POST', O('/checkout'), d),
  listarPedidos: (buyerId) => pedir('GET', O(`/${buyerId ? `?buyerId=${encodeURIComponent(buyerId)}` : ''}`)),
  actualizarPedido: (id, status) => pedir('PATCH', O(`/${id}/status`), { status }),

  // ---------------------------------------------------------------- pagos
  crearPago: (d) => pedir('POST', PAY('/'), d),
  autorizarPago: (id) => pedir('PATCH', PAY(`/${id}/authorize`)),
  listarPagos: (buyerId) => pedir('GET', PAY(`/${buyerId ? `?buyerId=${encodeURIComponent(buyerId)}` : ''}`)),
  verBilletera: (buyerId) => pedir('GET', PAY(`/wallet/${buyerId}`)),
  recargarBilletera: (buyerId, d) => pedir('POST', PAY(`/wallet/${buyerId}/top-up`), d),

  // ------------------------------------------------------------ simuladores
  simularStock: (d) => pedir('POST', '/api/v1/sim/stock-changed', d),
  simularBajaUsuario: (d) => pedir('POST', '/api/v1/sim/user-disabled', d),

  // ------------------------------------------------------------- diagnóstico
  salud: () => pedir('GET', '/api/v1/system/health'),
  colas: () => pedir('GET', '/api/v1/system/queues'),
};

function qs(obj) {
  const partes = Object.entries(obj).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return partes.length ? `?${new URLSearchParams(partes)}` : '';
}
