import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../common/config/configuration';
import { CORRELATION_HEADER } from '../common/correlation.middleware';
import { PrismaService } from '../prisma/prisma.service';

export interface ProducerValidation {
  producer_id: string;
  exists: boolean;
  active: boolean;
  /** Solo se entrega por la ruta interna autenticada para autorizar recursos propios. */
  user_id: string | null;
}

export interface FarmValidation {
  farm_id: string;
  exists: boolean;
  active: boolean;
  producer_id: string | null;
  producer_active: boolean;
}

/**
 * Comunicacion REST Catalogo -> Productores para respuestas inmediatas.
 * Nunca se consulta producer_db directamente.
 * Si el servicio no responde, se cae a la copia local alimentada por eventos
 * (tabla producer_refs) y, si tampoco hay copia, la operacion se rechaza con 503.
 */
@Injectable()
export class ProducerClientService {
  private readonly logger = new Logger(ProducerClientService.name);
  private readonly cfg: AppConfig;

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  async validateProducer(producerId: string, correlationId?: string): Promise<ProducerValidation> {
    try {
      return await this.get<ProducerValidation>(`/internal/producers/${producerId}/validate`, correlationId);
    } catch (err) {
      this.logger.warn(`producer-service no respondio para ${producerId}: ${(err as Error).message}`);
      const local = await this.prisma.producerRef.findUnique({ where: { producerId } });
      if (!local) {
        throw new ServiceUnavailableException('No se pudo validar el productor en este momento');
      }
      return { producer_id: producerId, exists: true, active: local.status === 'active', user_id: null };
    }
  }

  /** Las fincas no se replican localmente: siempre se valida contra Productores. */
  async validateFarm(farmId: string, correlationId?: string): Promise<FarmValidation> {
    try {
      return await this.get<FarmValidation>(`/internal/farms/${farmId}/validate`, correlationId);
    } catch (err) {
      this.logger.warn(`No se pudo validar la finca ${farmId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('No se pudo validar la finca en este momento');
    }
  }

  async producerIdByUserId(userId: string, correlationId?: string): Promise<string | null> {
    const response = await this.get<{ producer_id: string | null }>(`/internal/users/${userId}/producer`, correlationId);
    return response.producer_id;
  }

  private async get<T>(path: string, correlationId?: string): Promise<T> {
    const res = await firstValueFrom(
      this.http.get<T>(`${this.cfg.producerServiceUrl}${path}`, {
        timeout: this.cfg.producerServiceTimeoutMs,
        headers: {
          'x-internal-api-key': this.cfg.internalApiKey,
          ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
        },
      }),
    );
    return res.data;
  }
}
