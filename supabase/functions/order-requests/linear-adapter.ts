import { generateOrderPdf } from './order-pdf.ts';
// Provider-specific API, templates and upload behavior stay behind this adapter.
export function createLinearAdapter(db: any, env: (key: string) => string, checked: (result: any) => any) {
const labelOrderTemplateId = () => env('LINEAR_LABEL_ORDER_TEMPLATE_ID') || 'b8be76d3-d22c-4e18-9522-1f7f4824b733';
async function linear(query: string, variables: Record<string, unknown>) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST', headers: { Authorization: env('LINEAR_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(25000)
  });
  const body = await res.json();
  if (!res.ok || body.errors?.length || !body.data) {
    // Return only API error messages, never request headers, variables or credentials.
    const detail = (body.errors || []).map((e: any) => String(e.message || '')
      .replace(/lin_api_[A-Za-z0-9_-]+/g, '[redacted]')).join('; ').slice(0, 500);
    if (detail.includes('Invalid scope: `write` required')) throw new Error('The Linear API key needs Write permission to upload the quote. Update LINEAR_API_KEY in Supabase, then retry this request.');
    throw new Error(`Linear request failed (HTTP ${res.status})${detail ? ': ' + detail : '.'} Retry this request to reconcile it.`);
  }
  return body.data;
}
function description(r: any, external: any) {
  // Explicit values override Linear's template description. Preserve its field
  // structure while recording only facts known at intake (not billing approval).
  return [
    `### Today's Date\n\n${r.created_at.slice(0, 10)}`,
    `### Customer Name\n\n${r.company_name}`,
    `### Salesforce Link\n\n${r.crm_url || 'Not provided'}`,
    '### Invoice Recipient\n\nAwaiting customer confirmation',
    '### Billing Email\n\nAwaiting customer confirmation',
    `### Customer Quote\n\n[Completed quote PDF](${external.metadata.quote_asset_url})`,
    '### Label Order Form\n\nAwaiting customer submission',
    '### MetalCraft Quote\n\nNot provided',
    '### Customer PO\n\nNot provided',
    '### Customer logo\n\nNot provided',
    '### Other\n\nNot provided',
    `### Intake details\n\nContact: ${r.contact_name} <${r.contact_email}>`,
    `Code type: ${r.barcode_type}`,
    `Request: ${r.id}\n\nQuote version: ${r.quote_version} · SHA-256: ${r.quote_sha256}`,
    `Internal intake: ${env('ORDER_APP_URL')}/admin/prepare-order#request=${r.id}`,
    'Awaiting customer authorization. Creating this request or recording an email does not approve purchasing.'
  ].join('\n\n');
}
async function create(r: any, external: any) {
  if (!env('LINEAR_API_KEY') || !env('LINEAR_TEAM_ID') || !env('LINEAR_INTAKE_STATE_ID')) {
    throw new Error('Live Linear team, initial state and API key must be configured for external synchronization.');
  }
  // Query by the persisted UUID, never by customer name or a quote number.
  // A lost issueCreate response is reconciled here before another mutation.
  const lookup = await linear('query($id: ID!) { issues(filter: { id: { eq: $id } }) { nodes { id identifier url } } }', { id: external.external_id });
  let issue = lookup.issues.nodes[0];
  if (!issue) {
    const quote = r;
    if (!external.metadata.quote_asset_url) {
      const bytes = Uint8Array.from(atob(quote.quote_data), c => c.charCodeAt(0));
      const uploaded = await linear('mutation($name: String!, $size: Int!) { fileUpload(contentType: "application/pdf", filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }', { name: quote.quote_name, size: bytes.length });
      const file = uploaded.fileUpload.uploadFile;
      if (!uploaded.fileUpload.success || !file) throw new Error('Quote upload could not be prepared. Retry this request.');
      const headers = new Headers({ 'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=31536000' });
      file.headers.forEach((h: any) => headers.set(h.key, h.value));
      const put = await fetch(file.uploadUrl, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(30000) });
      if (!put.ok) throw new Error('Quote upload failed. The customer link is still usable; retry the sync.');
      external.metadata.quote_asset_url = file.assetUrl;
      checked(await db.from('order_requests').update({ external_metadata: external.metadata }).eq('id', external.id));
    }
    const created = await linear('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', {
      input: { id: external.external_id, templateId: labelOrderTemplateId(), teamId: env('LINEAR_TEAM_ID'), stateId: env('LINEAR_INTAKE_STATE_ID'),
        ...(env('LINEAR_PROJECT_ID') ? { projectId: env('LINEAR_PROJECT_ID') } : {}),
        title: `[Label Order] ${r.company_name}`, description: description(r, external) }
    });
    if (!created.issueCreate.success) throw new Error('Linear creation is unconfirmed. Retry this request.');
    issue = created.issueCreate.issue;
  }
  if (issue.id !== external.external_id) throw new Error('Linear request mapping mismatch.');
  checked(await db.from('order_requests').update({ external_identifier: issue.identifier, external_url: issue.url }).eq('id', external.id));
}
async function submitted(r: any, external: any) {
  const order = checked(await db.from('label_orders').select('*').eq('order_request_id', r.id).single());
  if (!order) throw new Error('The submitted order could not be found.');
  for (const audience of ['vendor', 'record'] as const) {
    const key = audience === 'vendor' ? 'vendor_pdf_url' : 'signed_pdf_url';
    if (external.metadata[key]) continue;
    const bytes = await generateOrderPdf(order, audience);
    const uploaded = await linear('mutation($name: String!, $size: Int!) { fileUpload(contentType: "application/pdf", filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }', {
      name: `${order.order_ref}-${audience}.pdf`, size: bytes.length
    });
    const file = uploaded.fileUpload.uploadFile;
    if (!uploaded.fileUpload.success || !file) throw new Error('Order PDF upload could not be prepared.');
    const headers = new Headers({ 'Content-Type': 'application/pdf' });
    file.headers.forEach((h: any) => headers.set(h.key, h.value));
    const put = await fetch(file.uploadUrl, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(30000) });
    if (!put.ok) throw new Error('Order PDF upload failed. Retry sync.');
    external.metadata[key] = file.assetUrl;
    checked(await db.from('order_requests').update({ external_metadata: external.metadata }).eq('id', r.id));
  }
  if (order.logo_choice === 'custom_logo' && order.logo_file_data && !external.metadata.artwork_asset_url) {
    const match = /^data:(image\/(?:png|jpeg|jpg|svg\+xml)|application\/pdf);base64,([\s\S]+)$/.exec(order.logo_file_data);
    if (!match) throw new Error('The saved customer artwork format is invalid.');
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    const contentType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    const uploaded = await linear('mutation($name: String!, $size: Int!, $contentType: String!) { fileUpload(contentType: $contentType, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }', {
      name: order.logo_file_name || order.order_ref + '-artwork', size: bytes.length, contentType
    });
    const file = uploaded.fileUpload.uploadFile;
    if (!uploaded.fileUpload.success || !file) throw new Error('Customer artwork upload could not be prepared.');
    const headers = new Headers({ 'Content-Type': contentType });
    file.headers.forEach((h: any) => headers.set(h.key, h.value));
    const put = await fetch(file.uploadUrl, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(30000) });
    if (!put.ok) throw new Error('Customer artwork upload failed. Retry sync.');
    external.metadata.artwork_asset_url = file.assetUrl;
    checked(await db.from('order_requests').update({ external_metadata: external.metadata }).eq('id', r.id));
  }
  // Read the current description so edits to the other template fields survive.
  const issueResult = await linear('query($id: String!) { issue(id: $id) { id description } }', { id: external.external_id });
  const issue = issueResult.issue;
  if (!issue || issue.id !== external.external_id) throw new Error('Submission issue mapping mismatch.');
  const current = issue.description || '';
  const form = `Submitted at ${order.submitted_at}.\n\nOrder reference: ${order.order_ref}\n\n[Vendor order PDF](${external.metadata.vendor_pdf_url})\n\n[Signed customer order PDF](${external.metadata.signed_pdf_url})`;
  const section = /(^#{1,6} Label Order Form[^\S\r\n]*\r?\n)([\s\S]*?)(?=^#{1,6} |$(?![\s\S]))/m;
  let updated = current;
  if (section.test(current)) {
    updated = current.replace(section, (_match: string, heading: string, content: string) => {
      const preserved = content.replace(/Awaiting customer submission\.?/g, '').trim();
      return heading + '\n' + (preserved.includes(external.metadata.signed_pdf_url)
        ? preserved : [preserved, form].filter(Boolean).join('\n\n')) + '\n\n';
    });
  } else {
    updated = current + '\n\n### Label Order Form\n\n' + form;
  }
  if (order.logo_choice === 'custom_logo' && external.metadata.artwork_asset_url) {
    const imagePreview = /^data:image\/(png|jpeg|jpg);base64,/i.test(order.logo_file_data || '')
      ? `![Customer artwork](${external.metadata.artwork_asset_url})` : '';
    const artwork = [`[Customer artwork](${external.metadata.artwork_asset_url})`, imagePreview].filter(Boolean).join('\n\n');
    const logoSection = /(^#{1,6} Customer logo[^\S\r\n]*\r?\n)([\s\S]*?)(?=^#{1,6} |$(?![\s\S]))/mi;
    if (logoSection.test(updated)) {
      updated = updated.replace(logoSection, (_match: string, heading: string, content: string) => {
        const preserved = content.replace(/^Not provided\.?\s*$/gm, '').trim();
        var contentWithLink = preserved.includes(external.metadata.artwork_asset_url)
          ? preserved : [preserved, artwork].filter(Boolean).join('\n\n');
        if (imagePreview && !contentWithLink.includes(imagePreview)) contentWithLink += '\n\n' + imagePreview;
        return heading + '\n' + contentWithLink + '\n\n';
      });
    } else updated += '\n\n### Customer logo\n\n' + artwork;
  }
  if (order.logo_choice === 'custom_text' && order.text_lines?.length) {
    // Indented code preserves literal punctuation and separate label lines.
    const text = order.text_lines.map((line: string) => '    ' + line).join('\n');
    const textSection = /(^#{1,6} Custom text[^\S\r\n]*\r?\n)([\s\S]*?)(?=^#{1,6} |$(?![\s\S]))/mi;
    if (!textSection.test(updated)) updated += '\n\n### Custom text\n\n' + text + '\n';
  }
  updated = updated.replace('Awaiting customer authorization. Creating this request or recording an email does not approve purchasing.',
    'Customer authorization received. Purchasing approval remains a separate internal step.');
  if (updated !== current) {
    const result = await linear('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      { id: external.external_id, input: { description: updated } });
    if (!result.issueUpdate.success) throw new Error('Linear order form update is unconfirmed. Retry sync.');
  }
  // Deterministic comment ID reconciles a lost response; update older comments
  // as well, so existing submissions can receive the new PDF attachments.
  const lookup = await linear('query($id: ID!) { comments(filter: { id: { eq: $id } }) { nodes { id issue { id } } } }', { id: r.id });
  const existing = lookup.comments.nodes[0];
  if (existing && existing.issue.id !== external.external_id) throw new Error('Submission mapping mismatch.');
  const body = `Customer authorization received at ${order.submitted_at}.\n\nOrder reference: ${order.order_ref}\n\n[Vendor order PDF](${external.metadata.vendor_pdf_url})\n\n[Signed customer order PDF](${external.metadata.signed_pdf_url})\n\n[Review signed order](${env('ORDER_APP_URL')}/admin/orders)\n\nRequest: ${r.id}. Quote version: ${r.quote_version}.`;
  if (existing) {
    const result = await linear('mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id: r.id, input: { body } });
    if (!result.commentUpdate.success) throw new Error('Linear submission update is unconfirmed.');
  } else {
    const result = await linear('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { id: r.id, issueId: external.external_id, body } });
    if (!result.commentCreate.success) throw new Error('Linear submission update is unconfirmed.');
  }
}

return { 'request.created': create, 'order.submitted': submitted };
}
