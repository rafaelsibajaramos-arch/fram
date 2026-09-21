// Selecciones compartidas entre vistas (qué productor/producto se está mirando).

const clave = 'ftt_estado';

export const estado = {
  productorId: null,
  productoId: null,
  loteId: null,
  ...JSON.parse(sessionStorage.getItem(clave) ?? '{}'),

  fijar(parche) {
    Object.assign(this, parche);
    const { productorId, productoId, loteId } = this;
    sessionStorage.setItem(clave, JSON.stringify({ productorId, productoId, loteId }));
  },
  limpiar() {
    this.productorId = null;
    this.productoId = null;
    this.loteId = null;
    sessionStorage.removeItem(clave);
  },
};
