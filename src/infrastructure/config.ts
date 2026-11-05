import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 3020: 3019 es reporting-service, el último ocupado (ver docker-compose.yml y los k8s/service.yaml).
  PORT: z.coerce.number().int().positive().default(3020),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  // Zona horaria con la que se decide qué vence «hoy» y desde qué hora se avisa (igual que ORG_TIMEZONE de tesorería).
  ORG_TIMEZONE: z.string().default('America/Guayaquil'),
  // 0 apaga el proceso de «vence pronto» (pruebas, réplicas extra).
  DUE_SOON_INTERVAL_MS: z.coerce.number().int().min(0).default(60 * 60 * 1000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
