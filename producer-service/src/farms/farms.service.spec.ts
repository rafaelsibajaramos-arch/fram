import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProducersService } from '../producers/producers.service';
import { createOutboxMock, createPrismaMock, producerUser } from '../test-utils/prisma.mock';
import { CreateFarmDto } from './dto/create-farm.dto';
import { FarmsService } from './farms.service';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCER_ID = '44444444-4444-4444-8444-444444444444';
const FARM_ID = '77777777-7777-4777-8777-777777777777';

function producerRow(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCER_ID,
    userId: USER_ID,
    fullName: 'Juan Perez',
    email: 'juan@example.com',
    phone: null,
    status: 'active',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function farmRow(over: Record<string, unknown> = {}) {
  return {
    id: FARM_ID,
    producerId: PRODUCER_ID,
    farmName: 'Finca La Esperanza',
    address: 'Vereda El Rosario',
    latitude: new Prisma.Decimal(8.757),
    longitude: new Prisma.Decimal(-75.89),
    active: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('FarmsService', () => {
  let prisma: any;
  let producers: ProducersService;
  let service: FarmsService;

  const dto: CreateFarmDto = {
    farm_name: 'Finca La Esperanza',
    address: 'Vereda El Rosario',
    latitude: 8.757,
    longitude: -75.89,
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    producers = new ProducersService(prisma, createOutboxMock() as any);
    service = new FarmsService(prisma, producers);
  });

  it('crea una finca para un productor activo', async () => {
    prisma.producer.findUnique.mockResolvedValue(producerRow());
    prisma.farm.create.mockResolvedValue(farmRow());

    const resultado = await service.create(PRODUCER_ID, dto, producerUser(USER_ID));

    expect(resultado).toEqual({
      id: FARM_ID,
      producer_id: PRODUCER_ID,
      farm_name: 'Finca La Esperanza',
      address: 'Vereda El Rosario',
      latitude: 8.757,
      longitude: -75.89,
      active: true,
    });
  });

  it('rechaza crear una finca para un productor inexistente', async () => {
    prisma.producer.findUnique.mockResolvedValue(null);
    await expect(service.create(PRODUCER_ID, dto, producerUser(USER_ID))).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.farm.create).not.toHaveBeenCalled();
  });

  it('rechaza crear una finca para un productor deshabilitado', async () => {
    prisma.producer.findUnique.mockResolvedValue(producerRow({ status: 'disabled' }));
    await expect(service.create(PRODUCER_ID, dto, producerUser(USER_ID))).rejects.toBeInstanceOf(ConflictException);
  });

  it('impide crear fincas en nombre de otro productor', async () => {
    prisma.producer.findUnique.mockResolvedValue(producerRow());
    await expect(
      service.create(PRODUCER_ID, dto, producerUser('88888888-8888-4888-8888-888888888888')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('validacion de coordenadas', () => {
    it.each([
      ['latitude', { ...dto, latitude: 91 }],
      ['latitude', { ...dto, latitude: -91 }],
      ['longitude', { ...dto, longitude: 181 }],
      ['longitude', { ...dto, longitude: -181 }],
    ])('rechaza %s fuera de rango', async (campo, payload) => {
      const instancia = plainToInstance(CreateFarmDto, payload);
      const errores = await validate(instancia);
      expect(errores.some((e) => e.property === campo)).toBe(true);
    });

    it('acepta coordenadas en el limite valido', async () => {
      const instancia = plainToInstance(CreateFarmDto, { ...dto, latitude: -90, longitude: 180 });
      expect(await validate(instancia)).toHaveLength(0);
    });
  });

  it('desactivar una finca es baja logica', async () => {
    prisma.farm.findUnique.mockResolvedValue(farmRow());
    prisma.producer.findUnique.mockResolvedValue(producerRow());
    prisma.farm.update.mockResolvedValue(farmRow({ active: false, version: 2 }));

    const resultado = await service.setActive(FARM_ID, false, producerUser(USER_ID));

    expect(resultado.active).toBe(false);
    expect(prisma.farm.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: false }) }),
    );
  });

  it('validate devuelve finca, estado y productor asociado', async () => {
    prisma.farm.findUnique.mockResolvedValue({
      id: FARM_ID,
      active: true,
      producerId: PRODUCER_ID,
      producer: { status: 'active' },
    });

    await expect(service.validate(FARM_ID)).resolves.toEqual({
      farm_id: FARM_ID,
      exists: true,
      active: true,
      producer_id: PRODUCER_ID,
      producer_active: true,
    });
  });

  it('validate responde exists=false cuando la finca no existe', async () => {
    prisma.farm.findUnique.mockResolvedValue(null);
    await expect(service.validate(FARM_ID)).resolves.toMatchObject({ exists: false, active: false });
  });
});
