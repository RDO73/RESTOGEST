import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const defaultPgliteDir = process.env.VERCEL ? '/tmp/restogest-pglite' : './data/pglite';

const explicitDbType = process.env.DATABASE_TYPE?.trim().toLowerCase();
const cloudPostgresUrl =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL;

const hasPostgresUrl =
  typeof cloudPostgresUrl === 'string' &&
  /^postgres(ql)?:\/\//i.test(cloudPostgresUrl);

const databaseType: 'embedded' | 'postgres' =
  explicitDbType === 'embedded'
    ? 'embedded'
    : explicitDbType === 'postgres' || hasPostgresUrl
      ? 'postgres'
      : 'embedded';

const resolvedAppUrl =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  'postgresql://restogest_app:app_secure_password@localhost:5432/restogest';

const resolvedAdminUrl =
  process.env.DATABASE_ADMIN_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  resolvedAppUrl;

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseType,
  pgliteDir: process.env.PGLITE_DATA_DIR || defaultPgliteDir,
  databaseUrl: resolvedAppUrl,
  databaseAdminUrl: resolvedAdminUrl,
  jwt: {
    secret: process.env.JWT_SECRET || 'super_secret_jwt_key_restogest_v1_change_in_production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  superAdmin: {
    email: (process.env.SUPER_ADMIN_EMAIL || 'admin@myrestogest.com').trim().toLowerCase(),
    password: process.env.SUPER_ADMIN_PASSWORD || 'RestoGestAdmin2026!',
    fullName: process.env.SUPER_ADMIN_NAME || 'Propriétaire RESTOGEST',
  },
};
