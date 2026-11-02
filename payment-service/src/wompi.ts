import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export type WompiTransaction = { id: string; reference: string; amount_in_cents: number; currency: string; status: string; payment_method_type?: string };
export function wompiConfig() {
  const publicKey = process.env.WOMPI_PUBLIC_KEY ?? '';
  const integrity = process.env.WOMPI_INTEGRITY_SECRET ?? '';
  const events = process.env.WOMPI_EVENTS_SECRET ?? '';
  const privateKey = process.env.WOMPI_PRIVATE_KEY ?? '';
  if (!publicKey.startsWith('pub_test_') || !integrity.startsWith('test_integrity_') || !events.startsWith('test_events_') || !privateKey.startsWith('prv_test_')) throw new ServiceUnavailableException('Wompi Sandbox pendiente de configuración');
  const redirect = process.env.WOMPI_REDIRECT_URL ?? '';
  const url = new URL(redirect || 'https://invalid.local');
  if (url.protocol !== 'https:' || !redirect) throw new ServiceUnavailableException('Configura WOMPI_REDIRECT_URL con la URL HTTPS de la tienda');
  return { publicKey, integrity, events, privateKey, redirect };
}
export function cents(amount: { toString(): string }): number {
  const value = amount.toString();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new BadRequestException('Importe inválido');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(result) || result <= 0) throw new BadRequestException('Importe fuera de rango');
  return result;
}
export function checkoutUrl(reference: string, amount: { toString(): string }, expiresAt: Date) {
  const config = wompiConfig();
  const amountInCents = cents(amount);
  const expiration = expiresAt.toISOString();
  const integrity = createHash('sha256').update(`${reference}${amountInCents}COP${expiration}${config.integrity}`).digest('hex');
  const params = new URLSearchParams({ 'public-key': config.publicKey, currency: 'COP', 'amount-in-cents': String(amountInCents), reference, 'signature:integrity': integrity, 'redirect-url': config.redirect, 'expiration-time': expiration });
  return `https://checkout.wompi.co/p/?${params}`;
}
export function verifyEvent(body: unknown): { transaction: WompiTransaction; checksum: string } {
  const config = wompiConfig();
  const event = body as { event?: string; environment?: string; timestamp?: number; data?: { transaction?: WompiTransaction }; signature?: { properties?: string[]; checksum?: string } };
  if (event?.event !== 'transaction.updated' || event.environment !== 'test' || !Number.isSafeInteger(event.timestamp)) throw new BadRequestException('Evento Wompi Sandbox inválido');
  const properties = event.signature?.properties;
  const checksum = event.signature?.checksum ?? '';
  if (!Array.isArray(properties) || properties.length < 3 || properties.length > 12 || !['transaction.id', 'transaction.status', 'transaction.amount_in_cents'].every(p => properties.includes(p)) || !/^[a-f0-9]{64}$/i.test(checksum)) throw new UnauthorizedException('Firma Wompi inválida');
  const values = properties.map(path => {
    if (!/^transaction\.[a-z_]+$/.test(path)) throw new UnauthorizedException('Propiedad de firma inválida');
    const value = event.data?.transaction?.[path.slice(12) as keyof WompiTransaction];
    if (!['string', 'number'].includes(typeof value)) throw new UnauthorizedException('Firma incompleta');
    return String(value);
  });
  const expected = createHash('sha256').update(values.join('') + event.timestamp + config.events).digest();
  if (!timingSafeEqual(expected, Buffer.from(checksum, 'hex'))) throw new UnauthorizedException('Firma Wompi inválida');
  if (!event.data?.transaction?.id) throw new BadRequestException('Transacción ausente');
  return { transaction: event.data.transaction, checksum: checksum.toLowerCase() };
}
export async function fetchTransaction(id: string): Promise<WompiTransaction> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new BadRequestException('Identificador de transacción inválido');
  const config = wompiConfig();
  const response = await fetch(`https://sandbox.wompi.co/v1/transactions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${config.privateKey}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new ServiceUnavailableException('No fue posible verificar la transacción con Wompi');
  const payload = await response.json() as { data: WompiTransaction };
  return payload.data;
}
