import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { type AppDependencies, healthRoutes, projectRoutes } from './routes.js';
import { contextMiddleware, errorHandler } from './middlewares.js';

export function createApp(deps: AppDependencies, opts: { log?: boolean } = {}): Hono {
  const app = new Hono();

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    app.use('*', httpInstrumentationMiddleware({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'projects-service',
      captureRequestHeaders: ['x-request-id'],
      spanNameFactory: (c) => `HTTP ${c.req.method} ${c.req.path}`,
    }));
  }
  if (opts.log !== false) app.use('*', logger());
  app.use('*', contextMiddleware());
  app.use(
    '*',
    cors({
      origin: deps.corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-User-Id', 'X-Country-Code', 'X-Permissions'],
    }),
  );

  app.route('/', healthRoutes());
  app.route('/', projectRoutes(deps));

  app.onError(errorHandler);
  app.notFound((c) => {
    // Un 404 normal no es un error del span (ver errorHandler).
    c.error = undefined;
    return c.json({ code: 'NOT_FOUND', message: 'Recurso no encontrado.' }, 404);
  });

  return app;
}
