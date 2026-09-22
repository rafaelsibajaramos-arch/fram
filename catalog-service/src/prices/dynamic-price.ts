import { Prisma, PriceReason } from '@prisma/client';

export interface PriceFactors {
  /** Multiplicador cuando el stock esta por debajo del umbral bajo (por defecto 1.10). */
  lowStockFactor: number;
  /** Multiplicador cuando el stock supera el umbral alto (por defecto 0.90). */
  highStockFactor: number;
}

export interface PriceInput {
  basePrice: Prisma.Decimal;
  lowStockThreshold: Prisma.Decimal;
  highStockThreshold: Prisma.Decimal;
  availableKg: Prisma.Decimal;
}

export interface PriceResult {
  price: Prisma.Decimal;
  reason: PriceReason;
}

/**
 * Regla de precio dinamico (seccion 27). Los factores son una decision de
 * diseno configurable, no una regla inmutable del negocio.
 *
 *   stock < low_stock_threshold  -> base * lowStockFactor
 *   stock > high_stock_threshold -> base * highStockFactor
 *   en otro caso                 -> base
 */
export function calcularPrecioDinamico(input: PriceInput, factors: PriceFactors): PriceResult {
  const { basePrice, lowStockThreshold, highStockThreshold, availableKg } = input;

  if (availableKg.lessThan(lowStockThreshold)) {
    return { price: redondear(basePrice.mul(factors.lowStockFactor)), reason: PriceReason.low_stock };
  }
  if (availableKg.greaterThan(highStockThreshold)) {
    return { price: redondear(basePrice.mul(factors.highStockFactor)), reason: PriceReason.high_stock };
  }
  return { price: redondear(basePrice), reason: PriceReason.normal_stock };
}

/** numeric(14,2): se redondea siempre a 2 decimales. */
export function redondear(valor: Prisma.Decimal): Prisma.Decimal {
  return valor.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
