import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marca una ruta que no exige JWT (health checks, rutas internas con su propio guard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
