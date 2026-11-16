import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseType: (process.env.DATABASE_TYPE || 'embedded') as 'embedded' | 'postgres',
  pgliteDir: process.env.PGLITE_DATA_DIR || './data/pglite',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://restogest_app:app_secure_password@localhost:5432/restogest',
  databaseAdminUrl: process.env.DATABASE_ADMIN_URL || 'postgresql://restogest_admin:admin_secure_password@localhost:5432/restogest',
  jwt: {
    secret: process.env.JWT_SECRET || 'super_secret_jwt_key_restogest_v1_change_in_production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
};
