import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../common/config/configuration';

/**
 * Cache de lectura del catalogo (TTL 30s por defecto).
 *
 * Redis NO es la fuente real del inventario: si falla, la aplicacion continua
 * leyendo de PostgreSQL. Nunca se usa un contador de Redis para evitar sobreventa.
 *
 * Carrera del patron cache-aside que este servicio evita:
 *
 *   1. Una lectura no encuentra la clave y consulta PostgreSQL.
 *   2. Mientras arma la respuesta, otra operacion cambia el dato e invalida.
 *   3. La lectura escribe en cache lo que leyo en el paso 1, ya obsoleto,
 *      y esa copia vieja sobrevive todo el TTL.
 *
 * Para cerrarla, cada invalidacion deja una marca con su instante. Antes de
 * escribir se compara esa marca con el momento en que empezo la lectura: si la
 * invalidacion es posterior, la escritura se descarta.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private readonly cfg: AppConfig;
  private client?: Redis;
  private disponible = false;

  /** Cuanto sobrevive la marca de invalidacion; basta con superar el TTL normal. */
  private readonly ttlMarcaSegundos: number;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>('app');
    this.ttlMarcaSegundos = Math.max(60, this.cfg.cacheTtlSeconds * 2);
  }

  onModuleInit(): void {
    if (!this.cfg.redisUrl) {
      this.logger.log('REDIS_URL vacio: la cache queda desactivada');
      return;
    }

    this.client = new Redis(this.cfg.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (intentos) => Math.min(intentos * 500, 5000),
    });

    this.client.on('ready', () => {
      this.disponible = true;
      this.logger.log('Cache Redis conectada');
    });
    this.client.on('error', (err) => {
      if (this.disponible) this.logger.warn(`Redis caido, se continua sin cache: ${err.message}`);
      this.disponible = false;
    });
    this.client.on('end', () => {
      this.disponible = false;
    });
  }

  isAvailable(): boolean {
    return this.disponible;
  }

  /** Instante a capturar ANTES de leer de PostgreSQL, para pasarlo luego a set(). */
  ahora(): number {
    return Date.now();
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.disponible || !this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  /**
   * Guarda el valor salvo que el dato se haya invalidado despues de que
   * empezara la lectura que lo produjo.
   */
  async set(
    key: string,
    value: unknown,
    opciones: { desde?: number; ttlSeconds?: number } = {},
  ): Promise<void> {
    if (!this.disponible || !this.client) return;
    const ttl = opciones.ttlSeconds ?? this.cfg.cacheTtlSeconds;

    try {
      if (opciones.desde !== undefined) {
        const marca = await this.client.get(marcaDe(key));
        if (marca && Number(marca) >= opciones.desde) {
          // La lectura arranco antes de la invalidacion: su resultado ya es viejo.
          this.logger.debug(`Escritura descartada por invalidacion concurrente: ${key}`);
          return;
        }
      }
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
    } catch {
      /* la cache nunca debe romper la peticion */
    }
  }

  /** Borra las claves y deja la marca que invalida escrituras en vuelo. */
  async del(...keys: string[]): Promise<void> {
    if (!this.disponible || !this.client || keys.length === 0) return;
    const ahora = String(Date.now());
    try {
      const tuberia = this.client.pipeline();
      for (const key of keys) {
        tuberia.del(key);
        tuberia.set(marcaDe(key), ahora, 'EX', this.ttlMarcaSegundos);
      }
      await tuberia.exec();
    } catch {
      /* ignorado a proposito */
    }
  }

  /** Invalida todo lo derivado de un producto tras un cambio. */
  async invalidateProduct(productId: string): Promise<void> {
    await this.del(CacheKeys.product(productId), CacheKeys.price(productId), CacheKeys.available());
  }

  async onApplicationShutdown(): Promise<void> {
    this.client?.disconnect();
  }
}

const marcaDe = (key: string) => `${key}:inval`;

export const CacheKeys = {
  product: (id: string) => `product:${id}`,
  price: (id: string) => `product:${id}:price`,
  available: () => 'products:available',
};
