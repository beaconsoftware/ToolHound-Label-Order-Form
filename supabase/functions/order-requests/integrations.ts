import { createLinearAdapter } from './linear-adapter.ts';

// New providers implement the same events; the request workflow never calls a
// vendor API. Provider enablement controls new mappings and job execution.
// Server setting, never customer input. "none" pauses all external writes.
export function integrationProvider(env: (key: string) => string) {
  const provider = env('ORDER_INTEGRATION_PROVIDER') || 'linear';
  if (provider === 'none') return null;
  if (provider !== 'linear') throw new Error('Unsupported ORDER_INTEGRATION_PROVIDER setting.');
  return provider;
}
export function createIntegrationRunner(db: any, env: (key: string) => string, checked: (result: any) => any, readRequest: (id: string) => Promise<any>) {
  const adapters: Record<string, any> = { linear: createLinearAdapter(db, env, checked) };
  return async function run(requestId: string) {
    const provider = integrationProvider(env);
    if (!provider) return;
    // Bounded work per invocation. Creation must finish before submission is claimed.
    for (let i = 0; i < 4; i++) {
      const jobs = checked(await db.rpc('claim_order_sync', { p_request_id: requestId, p_provider: provider }));
      const job = jobs[0];
      if (!job) return;
      let error = null;
      try {
        const request = await readRequest(requestId);
        if (request.external_provider !== job.provider) throw new Error('External provider changed; this job cannot run.');
        const external = { id: request.id, provider: request.external_provider, external_id: request.external_id, metadata: request.external_metadata };
        const adapter = adapters[external.provider];
        if (!adapter?.[job.event]) throw new Error('No adapter configured for ' + external.provider);
        await adapter[job.event](request, external);
      } catch (err) {
        error = err instanceof Error ? err.message : 'External sync failed. Retry sync.';
      }
      checked(await db.rpc('finish_order_sync', { p_id: job.id, p_event: job.event, p_claim_token: job.claim_token, p_error: error }));
      if (error) return;
    }
  };
}
