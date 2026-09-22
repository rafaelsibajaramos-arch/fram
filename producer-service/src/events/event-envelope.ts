import { randomUUID } from 'node:crypto';

/** Contrato estandar de eventos (seccion 49 de la especificacion). */
export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  source_service: string;
  entity_id: string;
  entity_version: number;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  payload: T;
}

export const PRODUCER_EVENTS = {
  created: 'producer.created',
  updated: 'producer.updated',
  disabled: 'producer.disabled',
} as const;

export const CONSUMED_EVENTS = {
  identityUserDisabled: 'identity.user_disabled',
} as const;

export function buildEnvelope<T extends Record<string, unknown>>(input: {
  eventType: string;
  sourceService: string;
  entityId: string;
  entityVersion: number;
  correlationId?: string;
  schemaVersion?: number;
  occurredAt?: Date;
  payload: T;
}): EventEnvelope<T> {
  return {
    event_id: randomUUID(),
    event_type: input.eventType,
    source_service: input.sourceService,
    entity_id: input.entityId,
    entity_version: input.entityVersion,
    schema_version: input.schemaVersion ?? 1,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    correlation_id: input.correlationId ?? randomUUID(),
    payload: input.payload,
  };
}
