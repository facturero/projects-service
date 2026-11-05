import './infrastructure/telemetry/otel.js';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { CollaborationUseCases } from './application/use-cases/collaboration-use-cases.js';
import { DueSoonUseCase } from './application/use-cases/due-soon.js';
import { MemberUseCases } from './application/use-cases/member-use-cases.js';
import { ProjectUseCases } from './application/use-cases/project-use-cases.js';
import { SectionUseCases } from './application/use-cases/section-use-cases.js';
import { TaskUseCases } from './application/use-cases/task-use-cases.js';
import { TimelineUseCases } from './application/use-cases/timeline-use-cases.js';
import { OrganizeUseCases } from './application/use-cases/organize-use-cases.js';
import { WorkspaceUseCases } from './application/use-cases/workspace-use-cases.js';
import { TimeUseCases } from './application/use-cases/time-use-cases.js';
import { WorkloadUseCases } from './application/use-cases/workload-use-cases.js';
import { BillingUseCases } from './application/use-cases/billing-use-cases.js';
import { AutomationUseCases } from './application/use-cases/automation-use-cases.js';
import { DashboardUseCases } from './application/use-cases/dashboard-use-cases.js';
import { startEventConsumer } from './infrastructure/messaging/consumer.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO `sequelize.sync()`: la migración (initContainer projects-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const gateway = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const repos = readOnlyRepositories;
  const clock = () => new Date();
  const ids = () => randomUUID();

  const tasks = new TaskUseCases(gateway, repos, clock, ids);
  const organize = new OrganizeUseCases(gateway, repos, clock, ids);
  const billing = new BillingUseCases(gateway, repos, clock, ids);
  const collaboration = new CollaborationUseCases(gateway, clock, ids);
  // Reglas (entregable 7): usan los mismos casos de uso que una persona; TaskUseCases las dispara tras confirmar cada cambio.
  const automation = new AutomationUseCases(gateway, repos, tasks, organize, collaboration, clock, ids);
  tasks.setRuleRunner((actor, events) => automation.run(actor, events));
  const app = createApp({
    useCases: {
      projects: new ProjectUseCases(gateway, repos, clock, ids),
      members: new MemberUseCases(gateway, repos, clock),
      sections: new SectionUseCases(gateway, clock, ids),
      tasks,
      collaboration,
      timeline: new TimelineUseCases(gateway, repos, clock, ids),
      organize,
      workspace: new WorkspaceUseCases(gateway, repos, tasks, organize, clock, ids),
      time: new TimeUseCases(gateway, repos, clock, ids),
      workload: new WorkloadUseCases(gateway, repos, clock),
      billing,
      automation,
      dashboard: new DashboardUseCases(tasks, clock),
    },
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[projects-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    // Entregable 6: el destino de las facturas del proyecto (emitida o anulada) llega por los eventos de billing-service.
    await startEventConsumer({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events', billing });
    console.log('[projects-service] outbox relay activo; consume billing.invoice.issued y billing.invoice.voided');
  } else {
    console.warn('[projects-service] RABBITMQ_URL no configurado: los eventos NO se publican');
  }

  // «Vence pronto»: cada hora. Con varias réplicas no duplica avisos (task_reminders), solo repite trabajo.
  if (config.DUE_SOON_INTERVAL_MS > 0) {
    const dueSoon = new DueSoonUseCase(gateway, repos, clock, config.ORG_TIMEZONE);
    const tick = () =>
      dueSoon
        .run()
        .then((r) => r.sent && console.log(`[projects-service] avisos de vencimiento enviados: ${r.sent}`))
        .catch((err) => console.error('[projects-service] proceso de vencimientos falló:', err));
    setTimeout(tick, 30_000);
    setInterval(tick, config.DUE_SOON_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error('[projects-service] error al iniciar:', err);
  process.exit(1);
});
