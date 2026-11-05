import { type EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import type { BillingUseCases } from '../../application/use-cases/billing-use-cases.js';

/**
 * Lo que consume projects-service (ver asyncapi.yaml): el destino de las facturas del proyecto en billing-service (entregable 6).
 * Pasa por el InboxConsumer: idempotente por `eventId`, con reintentos. Casi todas las facturas NO son de un proyecto; para esas el
 * caso de uso no encuentra la reserva y no hace nada.
 */
export const CONSUMED_BINDINGS = ['billing.invoice.issued', 'billing.invoice.voided'] as const;
export const QUEUE = 'projects-service.events';

export function buildEventHandlers(billing: BillingUseCases): EventHandler[] {
  return [
    { eventType: 'billing.invoice.issued', handle: (payload: unknown) => billing.onInvoiceIssued((payload ?? {}) as Record<string, unknown>) },
    { eventType: 'billing.invoice.voided', handle: (payload: unknown) => billing.onInvoiceVoided((payload ?? {}) as Record<string, unknown>) },
  ];
}

export async function startEventConsumer(params: { sequelize: Sequelize; rabbitmqUrl: string; exchange: string; billing: BillingUseCases }): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: QUEUE,
    bindings: [...CONSUMED_BINDINGS],
    handlers: buildEventHandlers(params.billing),
  });
  await consumer.start();
}
