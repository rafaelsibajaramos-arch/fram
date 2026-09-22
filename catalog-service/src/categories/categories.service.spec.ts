import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createPrismaMock } from '../test-utils/prisma.mock';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';

const CATEGORY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';

describe('CategoriesService', () => {
  let prisma: any;
  let service: CategoriesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new CategoriesService(prisma);
  });

  it('crea una categoria', async () => {
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.create.mockResolvedValue({ id: CATEGORY_ID, name: 'Frutas', active: true });

    await expect(service.create({ name: 'Frutas' })).resolves.toEqual({
      id: CATEGORY_ID,
      name: 'Frutas',
      active: true,
    });
  });

  it('rechaza una categoria duplicada (sin distinguir mayusculas)', async () => {
    prisma.category.findFirst.mockResolvedValue({ id: CATEGORY_ID, name: 'Frutas' });

    await expect(service.create({ name: 'frutas' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.category.create).not.toHaveBeenCalled();
  });

  it('normaliza espacios del nombre', async () => {
    const dto = plainToInstance(CreateCategoryDto, { name: '  Frutas   Rojas  ' });
    expect(dto.name).toBe('Frutas Rojas');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un nombre vacio', async () => {
    const dto = plainToInstance(CreateCategoryDto, { name: '    ' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('404 si la categoria no existe', async () => {
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(service.findOne(CATEGORY_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assertUsable rechaza una categoria desactivada', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: CATEGORY_ID, name: 'Frutas', active: false });
    await expect(service.assertUsable(CATEGORY_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
