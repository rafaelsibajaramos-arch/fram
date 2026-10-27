const fs = require('node:fs');
const env = require('../frontend/node_modules/dotenv').parse(fs.readFileSync(require('node:path').resolve(__dirname, '../.env')));
const { PrismaClient } = require('../producer-service/node_modules/@prisma/client');
const db = new PrismaClient({ datasourceUrl: env.PRODUCER_DIRECT_URL });
(async () => {
  console.log(JSON.stringify(await db.$queryRawUnsafe(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at`)));
  console.log(JSON.stringify(await db.$queryRawUnsafe(`SELECT column_name, udt_name, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_name='certificaciones' AND table_schema='public' ORDER BY ordinal_position`)));
  console.log(JSON.stringify(await db.$queryRawUnsafe(`SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname IN ('CertificationStatus','CertificationVerificationStatus') ORDER BY t.typname,e.enumsortorder`)));
  console.log(JSON.stringify(await db.$queryRawUnsafe(`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='certificaciones'`)));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
