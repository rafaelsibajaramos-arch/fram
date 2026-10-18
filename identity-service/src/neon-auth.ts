import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export interface NeonUser { id: string; email: string; name: string; emailVerified: boolean }
export class NeonAuthError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

/** Server-to-server client for the branch's published Managed Auth REST API. */
export class NeonAuth {
  get enabled() { return process.env.AUTH_PROVIDER === 'neon'; }
  async call<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    const base = new URL(process.env.NEON_AUTH_BASE_URL ?? '');
    if (base.protocol !== 'https:' || !base.hostname.endsWith('.neon.tech')) throw new ServiceUnavailableException('La autenticación no está configurada');
    let response: Response;
    try {
      response = await fetch(`${base.href.replace(/\/$/, '')}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: this.origin() },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12_000), redirect: 'error',
      });
    } catch { throw new ServiceUnavailableException('No se pudo conectar con autenticación. Intenta nuevamente.'); }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new NeonAuthError(response.status, String(data && typeof data === 'object' && 'code' in data ? data.code : 'AUTH_ERROR'));
    return data as T;
  }
  origin() { return new URL(process.env.APP_PUBLIC_URL ?? 'http://localhost:4000').origin; }
  signup(email: string, password: string, name: string) { return this.call<{ user: NeonUser; token?: string }>('/sign-up/email', { email, password, name }); }
  signin(email: string, password: string) { return this.call<{ user: NeonUser; token: string }>('/sign-in/email', { email, password }); }
  sendVerification(email: string) { return this.call('/email-otp/send-verification-otp', { email, type: 'email-verification' }); }
  verify(email: string, otp: string) { return this.call<{ user: NeonUser }>('/email-otp/verify-email', { email, otp }); }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (!(error instanceof NeonAuthError)) throw error;
      if (error.code.includes('EMAIL_NOT_VERIFIED')) throw new UnauthorizedException('Verifica tu correo con el código recibido antes de iniciar sesión');
      if (['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(error.code)) throw new ConflictException('El correo ya está registrado. Inicia sesión o recupera tu contraseña.');
      if (error.status === 429) throw new ServiceUnavailableException('Demasiados intentos. Espera unos minutos y vuelve a intentarlo.');
      if (error.status >= 500) throw new ServiceUnavailableException('El servicio de autenticación no está disponible en este momento');
      if (error.status === 401) throw new UnauthorizedException('El correo o la contraseña no son correctos');
      throw new BadRequestException('No se pudo completar la solicitud. Revisa el código o solicita un enlace nuevo.');
    }
  }
}
