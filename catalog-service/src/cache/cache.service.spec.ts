import { CacheKeys, CacheService } from './cache.service';
import { createConfigMock } from '../test-utils/prisma.mock';

/** Redis falso en memoria, con soporte de EX y pipeline. */
function crearRedisFalso() {
  const datos = new Map<string, string>();
  const cliente: any = {
    get: jest.fn(async (k: string) => datos.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      datos.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (...ks: string[]) => ks.forEach((k) => datos.delete(k))),
    pipeline: jest.fn(() => {
      const ops: Array<() => void> = [];
      const tuberia: any = {
        del: (k: string) => (ops.push(() => datos.delete(k)), tuberia),
        set: (k: string, v: string) => (ops.push(() => datos.set(k, v)), tuberia),
        exec: async () => ops.forEach((o) => o()),
      };
      return tuberia;
    }),
    on: jest.fn(),
    disconnect: jest.fn(),
  };
  return { cliente, datos };
}

function crearCache() {
  const servicio = new CacheService(createConfigMock({ redisUrl: 'redis://falso' }));
  const { cliente, datos } = crearRedisFalso();
  (servicio as any).client = cliente;
  (servicio as any).disponible = true;
  return { servicio, cliente, datos };
}

const CLAVE = CacheKeys.product('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');

describe('CacheService', () => {
  it('guarda y devuelve un valor', async () => {
    const { servicio } = crearCache();
    await servicio.set(CLAVE, { active: true });
    await expect(servicio.get(CLAVE)).resolves.toEqual({ active: true });
  });

  it('devuelve null cuando la clave no existe', async () => {
    const { servicio } = crearCache();
    await expect(servicio.get(CLAVE)).resolves.toBeNull();
  });

  it('del borra la clave', async () => {
    const { servicio } = crearCache();
    await servicio.set(CLAVE, { active: true });
    await servicio.del(CLAVE);
    await expect(servicio.get(CLAVE)).resolves.toBeNull();
  });

  describe('carrera de escritura obsoleta', () => {
    it('descarta la escritura si la invalidacion ocurrio despues de empezar la lectura', async () => {
      const { servicio } = crearCache();

      // 1. empieza una lectura
      const desde = servicio.ahora();
      await new Promise((r) => setTimeout(r, 5));

      // 2. otra operacion cambia el dato e invalida
      await servicio.del(CLAVE);
      await new Promise((r) => setTimeout(r, 5));

      // 3. la lectura intenta guardar lo que leyo, ya obsoleto
      await servicio.set(CLAVE, { active: true }, { desde });

      await expect(servicio.get(CLAVE)).resolves.toBeNull();
    });

    it('permite la escritura si la lectura empezo despues de la invalidacion', async () => {
      const { servicio } = crearCache();

      await servicio.del(CLAVE);
      await new Promise((r) => setTimeout(r, 5));
      const desde = servicio.ahora();

      await servicio.set(CLAVE, { active: false }, { desde });

      await expect(servicio.get(CLAVE)).resolves.toEqual({ active: false });
    });

    it('sin marca de lectura la escritura no se comprueba', async () => {
      const { servicio } = crearCache();
      await servicio.del(CLAVE);
      await servicio.set(CLAVE, { active: true });
      await expect(servicio.get(CLAVE)).resolves.toEqual({ active: true });
    });
  });

  it('invalidateProduct borra ficha, precio y lista de disponibles', async () => {
    const { servicio, datos } = crearCache();
    const id = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
    await servicio.set(CacheKeys.product(id), 1);
    await servicio.set(CacheKeys.price(id), 2);
    await servicio.set(CacheKeys.available(), 3);

    await servicio.invalidateProduct(id);

    expect(datos.has(CacheKeys.product(id))).toBe(false);
    expect(datos.has(CacheKeys.price(id))).toBe(false);
    expect(datos.has(CacheKeys.available())).toBe(false);
  });

  describe('cuando Redis no esta disponible', () => {
    it('get devuelve null y set no rompe', async () => {
      const servicio = new CacheService(createConfigMock({ redisUrl: '' }));
      await expect(servicio.get(CLAVE)).resolves.toBeNull();
      await expect(servicio.set(CLAVE, { a: 1 })).resolves.toBeUndefined();
      await expect(servicio.invalidateProduct('x')).resolves.toBeUndefined();
      expect(servicio.isAvailable()).toBe(false);
    });

    it('un fallo de Redis no propaga la excepcion', async () => {
      const { servicio, cliente } = crearCache();
      cliente.get.mockRejectedValue(new Error('conexion perdida'));
      cliente.set.mockRejectedValue(new Error('conexion perdida'));

      await expect(servicio.get(CLAVE)).resolves.toBeNull();
      await expect(servicio.set(CLAVE, { a: 1 })).resolves.toBeUndefined();
    });
  });
});
