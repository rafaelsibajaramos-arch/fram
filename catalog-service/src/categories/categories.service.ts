import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

export interface CategoryView {
  id: string;
  name: string;
  active: boolean;
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  static toView(c: Category): CategoryView {
    return { id: c.id, name: c.name, active: c.active };
  }

  async create(dto: CreateCategoryDto): Promise<CategoryView> {
    const duplicada = await this.prisma.category.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' } },
    });
    if (duplicada) throw new ConflictException('Ya existe una categoria con ese nombre');

    return CategoriesService.toView(await this.prisma.category.create({ data: { name: dto.name } }));
  }

  async findAll(): Promise<CategoryView[]> {
    const rows = await this.prisma.category.findMany({ orderBy: { name: 'asc' } });
    return rows.map(CategoriesService.toView);
  }

  async findOne(id: string): Promise<CategoryView> {
    return CategoriesService.toView(await this.getOrThrow(id));
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryView> {
    await this.getOrThrow(id);

    if (dto.name) {
      const duplicada = await this.prisma.category.findFirst({
        where: { name: { equals: dto.name, mode: 'insensitive' }, NOT: { id } },
      });
      if (duplicada) throw new ConflictException('Ya existe una categoria con ese nombre');
    }

    const actualizada = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return CategoriesService.toView(actualizada);
  }

  async getOrThrow(id: string): Promise<Category> {
    const categoria = await this.prisma.category.findUnique({ where: { id } });
    if (!categoria) throw new NotFoundException('Categoria inexistente');
    return categoria;
  }

  /** Una categoria desactivada no puede recibir productos nuevos ni reactivarlos. */
  async assertUsable(id: string): Promise<Category> {
    const categoria = await this.getOrThrow(id);
    if (!categoria.active) throw new ConflictException('La categoria no esta activa');
    return categoria;
  }
}
