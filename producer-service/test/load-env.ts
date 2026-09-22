// Carga el .env del servicio antes de que Jest evalue las pruebas E2E,
// para que PrismaClient encuentre DATABASE_URL.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env') });
