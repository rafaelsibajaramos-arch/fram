import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from './jwt-auth.guard';

export const ADMIN_ROLE = 'admin';

export function isAdmin(user: AuthUser): boolean {
  return user.roles?.includes(ADMIN_ROLE) ?? false;
}

/**
 * Regla del documento: JWT.sub == PRODUCTORES.user_id para tocar recursos propios.
 * Un admin puede gestionar segun las reglas de Identity.
 */
export function assertOwnership(user: AuthUser, ownerUserId: string, mensaje = 'El recurso no pertenece al usuario autenticado'): void {
  if (isAdmin(user)) return;
  if (!user.sub || user.sub !== ownerUserId) {
    throw new ForbiddenException(mensaje);
  }
}

export function assertAdmin(user: AuthUser, mensaje = 'Operacion reservada a administradores'): void {
  if (!isAdmin(user)) throw new ForbiddenException(mensaje);
}
