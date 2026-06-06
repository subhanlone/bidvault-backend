import { env } from '../config/env.js';

interface N8NEventPayload {
  event: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export async function triggerN8nWorkflow(event: string, payload: Record<string, unknown>): Promise<void> {
  const url = env.N8N_WEBHOOK_URL?.trim();
  if (!url) return;

  const body: N8NEventPayload = { event, payload, occurredAt: new Date().toISOString() };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.N8N_WEBHOOK_TOKEN) headers['Authorization'] = `Bearer ${env.N8N_WEBHOOK_TOKEN}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (res.ok) return;
    } catch {
      // network error or timeout — fall through to retry
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 500));
  }

  console.error(`[n8n] webhook failed after 2 attempts for event: ${event}`);
}
