import { env } from '../config/env.js';

interface N8NEventPayload {
  event: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export async function triggerN8nWorkflow(event: string, payload: Record<string, unknown>): Promise<void> {
  const url = env.N8N_WEBHOOK_URL?.trim();
  if (!url) {
    return;
  }

  const body: N8NEventPayload = {
    event,
    payload,
    occurredAt: new Date().toISOString(),
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.N8N_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.N8N_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error('n8n webhook failed:', error);
  }
}
