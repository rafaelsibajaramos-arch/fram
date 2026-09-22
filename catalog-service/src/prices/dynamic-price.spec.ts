import { Prisma } from '@prisma/client';
import { calcularPrecioDinamico } from './dynamic-price';

const FACTORES = { lowStockFactor: 1.1, highStockFactor: 0.9 };

function entrada(available: number, base = 5000, low = 20, high = 100) {
  return {
    basePrice: new Prisma.Decimal(base),
    lowStockThreshold: new Prisma.Decimal(low),
    highStockThreshold: new Prisma.Decimal(high),
    availableKg: new Prisma.Decimal(available),
  };
}

describe('calcularPrecioDinamico', () => {
  it('sube 10% cuando el stock esta por debajo del umbral bajo', () => {
    // Ejemplo de la especificacion: base 5.000, stock 10 kg, low 20 kg -> 5.500
    const resultado = calcularPrecioDinamico(entrada(10), FACTORES);
    expect(resultado.price.toString()).toBe('5500');
    expect(resultado.reason).toBe('low_stock');
  });

  it('baja 10% cuando el stock supera el umbral alto', () => {
    const resultado = calcularPrecioDinamico(entrada(150), FACTORES);
    expect(resultado.price.toString()).toBe('4500');
    expect(resultado.reason).toBe('high_stock');
  });

  it('usa el precio base en el rango normal', () => {
    const resultado = calcularPrecioDinamico(entrada(50), FACTORES);
    expect(resultado.price.toString()).toBe('5000');
    expect(resultado.reason).toBe('normal_stock');
  });

  it('el umbral bajo es exclusivo: stock == low es rango normal', () => {
    expect(calcularPrecioDinamico(entrada(20), FACTORES).reason).toBe('normal_stock');
  });

  it('el umbral alto es exclusivo: stock == high es rango normal', () => {
    expect(calcularPrecioDinamico(entrada(100), FACTORES).reason).toBe('normal_stock');
  });

  it('stock cero se considera stock bajo', () => {
    expect(calcularPrecioDinamico(entrada(0), FACTORES).reason).toBe('low_stock');
  });

  it('redondea a 2 decimales', () => {
    const resultado = calcularPrecioDinamico(entrada(1, 3333.33), FACTORES);
    expect(resultado.price.toString()).toBe('3666.66');
  });

  it('los factores son configurables', () => {
    const resultado = calcularPrecioDinamico(entrada(10), { lowStockFactor: 1.25, highStockFactor: 0.8 });
    expect(resultado.price.toString()).toBe('6250');
  });

  it('no pierde precision con decimales de moneda', () => {
    const resultado = calcularPrecioDinamico(entrada(10, 0.1), FACTORES);
    expect(resultado.price.toString()).toBe('0.11');
  });
});
