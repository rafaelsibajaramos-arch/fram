import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from './prisma.service';

@Controller('analytics')
@UseGuards(AdminGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly db: PrismaService) {}
  @Get('sales') sales(@Query() query: Record<string, unknown>) { return this.analytics.sales(query); }
  @Get('waste') waste(@Query() query: Record<string, unknown>) { return this.analytics.waste(query); }
  @Get('inventory-rotation') inventoryRotation(@Query() query: Record<string, unknown>) { return this.analytics.inventoryRotation(query); }
  @Get('deliveries') deliveries(@Query() query: Record<string, unknown>) { return this.analytics.deliveries(query); }
  @Get('satisfaction') satisfaction(@Query() query: Record<string, unknown>) { return this.analytics.satisfaction(query); }
  @Post('reports/:type') generate(@Param('type') type: string, @Body() body: Record<string, unknown>) { return this.analytics.generateReport(type, body); }
  @Post('rebuild') rebuild(@Body() body?: Record<string, unknown>) { return this.analytics.rebuildProjections(body?.confirmation); }
  @Get('reports') reports(@Query('limit') limit?: string) { return this.db.reportFact.findMany({ orderBy: { generatedAt: 'desc' }, take: safeLimit(limit), select: { id: true, reportType: true, startAt: true, endAt: true, timezone: true, generatedAt: true } }); }
}

function safeLimit(value?: string) { const n = Number(value ?? 20); return Number.isInteger(n) && n > 0 ? Math.min(100, n) : 20; }
