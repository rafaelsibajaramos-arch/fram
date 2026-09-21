import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './common/config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const cfg = app.get(ConfigService).getOrThrow<AppConfig>('app');
  const logger = new Logger('bootstrap');

  app.use(helmet());
  app.enableShutdownHooks();

  // CORS con origenes exactos, nunca "*" en produccion.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // 422 para reglas de negocio invalidas, coherente con la seccion 40.
      errorHttpStatusCode: 422,
    }),
  );

  await app.listen(cfg.port, '0.0.0.0');
  logger.log(`${cfg.serviceName} escuchando en el puerto ${cfg.port} (${cfg.nodeEnv})`);
  if (cfg.authDisabled) logger.warn('AUTH_DISABLED=true: el guard de JWT esta desactivado');
}

void bootstrap();
