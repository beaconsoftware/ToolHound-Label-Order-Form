import { storeArtwork } from './artwork-storage.ts';
import { isTestOperator, testOrderFixture } from './test-runner.ts';
import { generateOrderPdf } from './order-pdf.ts';
import { createIntegrationRunner, integrationProvider } from './integrations.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const env = (key: string) => Deno.env.get(key) || '';
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const hash = async (text: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function token(id: string, version = 1) {
  const secret = env('ORDER_LINK_SECRET');
  if (secret.length < 32) throw new Error('Order link signing is not configured.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}:${version}`)));
}
function checked(result: any) {
  if (result.error) {
    if (['23514', '23502', '22P02', '22003', '22007', '22008'].includes(result.error.code)) throw new Error('Some order details were rejected as invalid. Check the quantity, label specifications, address and authorization, then try again.');
    throw new Error('The request could not be saved. Retry using the same request.');
  }
  return result.data;
}
async function update(id: string, values: Record<string, unknown>) {
  checked(await db.from('order_requests').update(values).eq('id', id));
}
async function staff(req: Request) {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
  const { data, error } = await db.auth.getUser(bearer);
  if (error || !data.user?.email || !data.user.email_confirmed_at) throw new Error('Sign in with an authorized staff account.');
  // Use the same current-account authorization as RLS, under the caller's JWT.
  const caller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${bearer}` } }
  });
  const permission = await caller.rpc('is_label_order_staff');
  if (permission.error || permission.data !== true) throw new Error('This account does not have intake access.');
  return data.user;
}
function withReceipt(r: any) {
  if (!r) return r;
  const order = Array.isArray(r.label_orders) ? r.label_orders[0] : r.label_orders;
  const jobs = Object.values(r.external_sync || {}).filter((j: any) => j.provider === r.external_provider);
  const integrations = r.external_provider ? [{ provider: r.external_provider, identifier: r.external_identifier, url: r.external_url, pending: jobs.some((j: any) => j.status !== 'succeeded'), error: jobs.find((j: any) => j.last_error)?.last_error || null }] : [];
  return { ...r, integrations, submitted_at: order?.submitted_at || r.shadow_receipt?.submitted_at || null,
    order_ref: order?.order_ref || r.shadow_receipt?.order_ref || null, order_id: order?.id || null };
}
const receiptJoin = 'label_orders(id,order_ref,submitted_at)';
async function readRequest(id: string) { return withReceipt(checked(await db.from('order_requests').select('*,' + receiptJoin).eq('id', id).single())); }
const runIntegrations = createIntegrationRunner(db, env, checked, readRequest);
function background(task: Promise<unknown>) {
  const safe = task.catch(() => { /* Sync operations remain pending or reclaimable after lease expiry. */ });
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(safe);
}
function scheduleSync(id: string) { background(runIntegrations(id)); }
function scheduleBatch(ids: string[]) { background((async () => { for (const id of ids) await runIntegrations(id); })()); }
function summary(r: any) {
  return { id: r.id, company_name: r.company_name, contact_name: r.contact_name, contact_email: r.contact_email,
    barcode_type: r.barcode_type, quote_name: r.quote_name, quote_version: r.quote_version, previous_order_name: r.previous_order_name, created_at: r.created_at,
    mode: r.mode, request_state: r.request_state, integrations: r.integrations,
    sent_at: r.sent_at, sent_recipient: r.sent_recipient, submitted_at: r.submitted_at, revoked_at: r.revoked_at,
    sync_pending: (r.integrations || []).some((e: any) => e.pending), expires_at: r.expires_at, token_version: r.token_version, regenerated_at: r.regenerated_at, order_ref: r.order_ref };
}
async function resultWithLink(r: any) {
  const value = await token(r.id, r.token_version);
  if (await hash(value) !== r.token_hash) throw new Error('Link signing key changed. Restore the original key before recovering this link.');
  const route = r.barcode_type === 'qr' ? 'qr-code' : 'linear-barcode';
  // Fragment keeps the bearer token out of web-server logs and Referer headers.
  return { ...summary(r), customer_url: `${r.app_origin || env('ORDER_APP_URL').replace(/\/$/, '')}/${route}#request=${r.id}&token=${value}` };
}
function text(value: unknown, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('Complete all required fields within their length limits.');
  return value.trim();
}
// Bound bytes while streaming, including chunked requests without Content-Length.
// Two 10 MB PDFs encode to ~28 MB; ordinary customer submissions are smaller.
const MAX_REQUEST_BYTES = 28_500_000;
async function readJson(req: Request) {
  if (Number(req.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new Error('Request is too large.');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('Invalid request body.');
  const decoder = new TextDecoder();
  let size = 0, json = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('Request is too large.'); }
      json += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(json + decoder.decode()); } catch { throw new Error('Invalid JSON request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request body.');
  return body;
}

async function handle(req: Request, appOrigin: string) {
  const body = await readJson(req);
  if (body.action === 'load' || body.action === 'submit') {
    if (!uuid.test(body.id || '') || !/^[0-9a-f]{64}$/.test(body.token || '')) throw new Error('This customer link is invalid. Contact ToolHound for a new link.');
    const digest = await hash(body.token);
    const r = withReceipt(checked(await db.from('order_requests').select('id,mode,barcode_type,company_name,contact_name,contact_email,request_state,shadow_receipt,expires_at,revoked_at,label_orders(id,order_ref,submitted_at)').eq('id', body.id).eq('token_hash', digest).maybeSingle()));
    if (!r || r.revoked_at || r.request_state !== 'ready') throw new Error('This customer link is invalid. Contact ToolHound for a new link.');
    if (!r.submitted_at && new Date(r.expires_at).getTime() < Date.now()) throw new Error('This customer link has expired. Contact ToolHound for a new link.');
    if (body.action === 'load') {
      return { mode: r.mode, barcode_type: r.barcode_type, submitted_at: r.submitted_at,
        ...(r.submitted_at ? { order_ref: r.order_ref } : {
          prefill: { companyName: r.company_name, contactName: r.contact_name, contactEmail: r.contact_email }
        }) };
    }
    const row = body.row;
    if (!row || typeof row !== 'object' || Array.isArray(row) || JSON.stringify(row).length > 9000000) throw new Error('Invalid order details.');
    for (const key of ['company_name','contact_name','contact_email','address','city','state_province','postal_code','country','authorized_name']) text(row[key]);
    if (!email.test(row.contact_email) || !row.signature_data?.startsWith('data:image/png;base64,') || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000000) throw new Error('Complete the order details and authorization before submitting.');
    if (row.customer_po != null && row.customer_po !== '') row.customer_po = text(row.customer_po, 64);
    // Never accept storage references chosen by an anonymous caller.
    if (row.logo_storage_path != null) throw new Error('Upload the artwork using this form.');
    if (!r.submitted_at && row.logo_choice === 'custom_logo') {
      text(row.logo_file_name, 260);
      if (typeof row.logo_file_data !== 'string') throw new Error('Upload your artwork before submitting.');
      if (r.mode === 'live') {
        row.logo_storage_path = await storeArtwork(db, r.id, row.logo_file_data);
        row.logo_file_data = null;
      }
    }
    const receipt = checked(await db.rpc('submit_order_request', { p_id: r.id, p_token_hash: digest, p_row: row }));
    const saved = withReceipt(checked(await db.from('order_requests').select('*,' + receiptJoin).eq('id', r.id).single()));
    scheduleSync(saved.id);
    return receipt;
  }
  const user = await staff(req);
  if (body.action === 'test_run') {
    if (!isTestOperator(user)) throw new Error('This test runner is restricted to its owner.');
    if (env('ORDER_REQUESTS_MODE') !== 'live') throw new Error('Production mode must be enabled to run this test.');
    if (!uuid.test(body.id || '')) throw new Error('Invalid test request ID.');
    const fixture = testOrderFixture(body.scenario);
    const existing = checked(await db.from('order_requests').select('created_by,mode,company_name,quote_name').eq('id', body.id).maybeSingle());
    const quoteName = 'TEST-' + fixture.key + '.pdf';
    if (existing && (existing.created_by !== user.id || existing.mode !== 'live' ||
      existing.company_name !== fixture.row.company_name || existing.quote_name !== quoteName)) {
      throw new Error('This request belongs to another run. Start a new test.');
    }
    // Use the ordinary creation and token submission handlers, including their
    // validation, durable integration jobs and one-order-per-request guarantee.
    const invoke = (payload: any) => handle(new Request(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(payload)
    }), appOrigin);
    let created;
    if (existing) {
      created = await invoke({action:'recover',id:body.id});
    } else {
      const pdf = await generateOrderPdf({...fixture.row,order_ref:'TEST QUOTE',submitted_at:new Date().toISOString()},'vendor');
      let binary = '';
      for (let i=0;i<pdf.length;i+=8192) binary += String.fromCharCode(...pdf.subarray(i,i+8192));
      created = await invoke({action:'create',id:body.id,company_name:fixture.row.company_name,
        contact_name:fixture.row.contact_name,contact_email:fixture.row.contact_email,
        barcode_type:fixture.row.barcode_type,quote_name:quoteName,quote_data:btoa(binary)});
    }
    if (created.quote_name !== quoteName || created.barcode_type !== fixture.row.barcode_type) throw new Error('This request already belongs to a different scenario.');
    const params = new URLSearchParams(new URL(created.customer_url).hash.slice(1));
    const receipt = await invoke({action:'submit',id:body.id,token:params.get('token'),row:fixture.row});
    return {...created,...receipt,scenario:fixture.key};
  }

  if (body.action === 'order_pdf') {
    if (!uuid.test(body.id || '') || !['vendor', 'record'].includes(body.audience)) throw new Error('Invalid order PDF.');
    const order = checked(await db.from('label_orders').select('*').eq('id', body.id).maybeSingle());
    if (!order) throw new Error('Order not found.');
    let bytes: Uint8Array | null = null;
    if (order.order_request_id) {
      const request = checked(await db.from('order_requests').select('external_metadata').eq('id', order.order_request_id).single());
      const key = body.audience === 'vendor' ? 'vendor_pdf_url' : 'signed_pdf_url';
      const url = request.external_metadata?.[key];
      // Return the exact uploaded artifact, not a freshly rendered approximation.
      if (url) {
        if (new URL(url).origin !== 'https://uploads.linear.app') throw new Error('Invalid saved PDF location.');
        const file = await fetch(url, { headers: { Authorization: env('LINEAR_API_KEY') }, redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!file.ok) throw new Error('Could not retrieve the attached PDF. Please retry.');
        bytes = new Uint8Array(await file.arrayBuffer());
      }
    }
    // Legacy orders and pending syncs use the same renderer as the Linear adapter.
    if (!bytes) bytes = await generateOrderPdf(order, body.audience);
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The saved file is not a PDF.');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { pdf_data: btoa(binary), pdf_name: order.order_ref + '-' + body.audience + '.pdf' };
  }
  if (body.action === 'previous_order') {
    if (!uuid.test(body.id || '')) throw new Error('Invalid request ID.');
    const doc = checked(await db.from('order_requests').select('previous_order_name,previous_order_data').eq('id', body.id).maybeSingle());
    if (!doc?.previous_order_data) throw new Error('No previous order PDF is attached.');
    return { quote_name: doc.previous_order_name, quote_data: doc.previous_order_data };
  }
  if (body.action === 'quote') {
    if (!uuid.test(body.id || '')) throw new Error('Invalid request ID.');
    const quote = checked(await db.from('order_requests').select('quote_name,quote_data').eq('id', body.id).maybeSingle());
    if (!quote) throw new Error('Quote not found.');
    return { quote_name: quote.quote_name, quote_data: quote.quote_data };
  }
  if (body.action === 'list') {
    const rows = checked(await db.from('order_requests').select('id,company_name,contact_name,contact_email,barcode_type,quote_name,quote_version,previous_order_name,created_at,mode,request_state,sent_at,sent_recipient,shadow_receipt,expires_at,revoked_at,token_version,regenerated_at,external_provider,external_identifier,external_url,external_sync,' + receiptJoin).order('created_at', { ascending: false }).limit(250));
    // Revisit durable pending jobs while the dashboard is active. Backoff and leases are enforced in SQL.
    scheduleBatch(rows.filter((row: any) => Object.values(row.external_sync || {}).some((j: any) => j.provider === row.external_provider && j.status !== 'succeeded')).slice(0, 3).map((row: any) => row.id));
    return { requests: rows.map((row: any) => summary(withReceipt(row))) };
  }
  if (!uuid.test(body.id || '')) throw new Error('Invalid request ID.');
  let r = withReceipt(checked(await db.from('order_requests').select('*,' + receiptJoin).eq('id', body.id).maybeSingle()));
  if (body.action === 'create' && !r) {
    const company = text(body.company_name), contact = text(body.contact_name), contactEmail = text(body.contact_email);
    if (!email.test(contactEmail) || !['linear','qr'].includes(body.barcode_type)) throw new Error('Choose a supported label form and enter a valid email.');
    const quoteName = text(body.quote_name);
    if (typeof body.quote_data !== 'string' || body.quote_data.length > 14000000) throw new Error('Upload a PDF smaller than 10 MB.');
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(atob(body.quote_data), c => c.charCodeAt(0)); } catch { throw new Error('Invalid quote PDF.'); }
    if (bytes.length > 10 * 1024 * 1024 || new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw new Error('Upload a valid completed quote PDF smaller than 10 MB.');
    let previousName = null, previousData = null;
    if (body.previous_order_name != null || body.previous_order_data != null) {
      previousName = text(body.previous_order_name);
      if (typeof body.previous_order_data !== 'string' || body.previous_order_data.length > 14000000) throw new Error('Previous order must be a PDF up to 10 MB.');
      let previousBytes;
      try { previousBytes = Uint8Array.from(atob(body.previous_order_data), c => c.charCodeAt(0)); } catch { throw new Error('Invalid previous order PDF.'); }
      if (previousBytes.length > 10 * 1024 * 1024 || new TextDecoder().decode(previousBytes.slice(0,5)) !== '%PDF-') throw new Error('Previous order must be a PDF up to 10 MB.');
      previousData = body.previous_order_data;
    }
    let crm = null;
    if (body.salesforce_url) {
      crm = text(body.salesforce_url, 2000);
      const url = new URL(crm);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS CRM link.');
    }
    const customerToken = await token(body.id);
    const values = { id: body.id, created_by: user.id, mode: env('ORDER_REQUESTS_MODE') === 'live' ? 'live' : 'shadow',
      company_name: company, contact_name: contact, contact_email: contactEmail, crm_url: crm,
      previous_order_name: previousName, previous_order_data: previousData,
      barcode_type: body.barcode_type, app_origin: appOrigin, token_hash: await hash(customerToken) };
    const inserted = await db.rpc('create_order_request', { p_request: values, p_provider: integrationProvider(env), p_quote: { name: quoteName, data_base64: body.quote_data, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) } });
    if (inserted.error && inserted.error.code !== '23505') checked(inserted);
    r = withReceipt(checked(await db.from('order_requests').select('*,' + receiptJoin).eq('id', body.id).single()));
  }
  if (!r) throw new Error('Request not found.');
  if (body.action === 'revoke') {
    if (r.submitted_at) throw new Error('A submitted authorization cannot be revoked here.');
    checked(await db.rpc('revoke_order_request', { p_id: r.id }));
    return { ok: true };
  }
  if (r.revoked_at) throw new Error('This request has been revoked. Prepare a new request for the revised quote.');
  if (body.action === 'regenerate') {
    if (!Number.isInteger(body.token_version) || body.token_version < 1) throw new Error('Refresh the request history before regenerating.');
    const value = await token(r.id, body.token_version + 1);
    checked(await db.rpc('regenerate_order_request', { p_id: r.id, p_version: body.token_version, p_token_hash: await hash(value) }));
    r = withReceipt(checked(await db.from('order_requests').select('*,' + receiptJoin).eq('id', r.id).single()));
    return await resultWithLink(r);
  }
  if (body.action === 'create' || body.action === 'recover') {
    scheduleSync(r.id);
    return await resultWithLink(r);
  }
  if (body.action === 'mark_sent') {
    if (r.request_state !== 'ready') throw new Error('Prepare the request before marking sent.');
    const recipient = text(body.recipient);
    const sent = new Date(body.sent_at);
    if (!email.test(recipient) || !Number.isFinite(sent.getTime()) || sent.getTime() > Date.now() || sent.getTime() < new Date(r.created_at).getTime()) throw new Error('Enter the recipient and actual past send time after this request was created.');
    await update(r.id, { sent_at: sent.toISOString(), sent_recipient: recipient, sent_recorded_at: new Date().toISOString(), sent_by: user.id });
    return { ok: true };
  }
  if (body.action === 'sync') {
    checked(await db.rpc('retry_order_integrations', { p_request_id: r.id }));
    await runIntegrations(r.id);
    return summary(await readRequest(r.id));
  }
  throw new Error('Unsupported request action.');
}
Deno.serve(async req => {
  const origin = req.headers.get('origin') || '';
  const canonical = env('ORDER_APP_URL').replace(/\/$/, '');
  const allowedOrigins = new Set([canonical, ...env('ORDER_ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)]);
  const allowed = origin && allowedOrigins.has(origin) ? origin : canonical;
  const cors = { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
  if (origin && !allowedOrigins.has(origin)) return new Response('Origin not allowed', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  try { return Response.json(await handle(req, allowed), { headers: cors }); }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Request failed. Please retry.' }, { status: 400, headers: cors }); }
});
