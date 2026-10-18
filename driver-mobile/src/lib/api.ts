import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { getRefreshToken, saveCredentials } from './offline';

const configuredBase = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');
const fallbackBase = Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
export const API_BASE = configuredBase || fallbackBase;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; full_name: string; roles: string[] };
};

type RefreshResponse = { access_token: string; refresh_token: string };

let refreshInFlight: Promise<string | null> | null = null;

async function decode<T>(response: Response): Promise<T> {
  const content = await response.text();
  let body: any = null;
  try { body = content ? JSON.parse(content) : null; } catch { body = content; }
  if (!response.ok) {
    const detail = Array.isArray(body?.message) ? body.message.join(' · ') : body?.message;
    throw new ApiError(response.status, detail || `Error HTTP ${response.status}`);
  }
  return body as T;
}

async function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) return null;
      try {
        const response = await fetch(`${API_BASE}/api/v1/identity/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken, device_name: 'FarmToTable conductor' }),
          signal: AbortSignal.timeout(15_000),
        });
        const result = await decode<RefreshResponse>(response);
        await saveCredentials(result.access_token, result.refresh_token);
        return result.access_token;
      } catch {
        return null;
      }
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function apiRequest<T>(
  path: string,
  token: string,
  method: 'GET' | 'PATCH' | 'POST' = 'GET',
  payload?: Record<string, unknown>,
  operationId?: string,
): Promise<T> {
  const send = (accessToken: string) => fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(operationId ? { 'idempotency-key': operationId, 'x-operation-id': operationId } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(20_000),
  });

  let response: Response;
  try {
    response = await send(token);
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('La solicitud tardó demasiado; se conservará para reintentar con el mismo identificador.');
    }
    throw error;
  }
  if (response.status === 401 && !path.endsWith('/auth/refresh')) {
    const renewed = await refreshAccessToken();
    if (renewed) response = await send(renewed);
  }
  return decode<T>(response);
}

export async function login(email: string, password: string) {
  const response = await fetch(`${API_BASE}/api/v1/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password, device_name: 'FarmToTable conductor' }),
    signal: AbortSignal.timeout(20_000),
  });
  return decode<LoginResponse>(response);
}

export async function newOperationId() {
  return Crypto.randomUUID();
}
