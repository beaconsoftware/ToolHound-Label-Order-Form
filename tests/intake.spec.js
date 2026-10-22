const { test, expect } = require('@playwright/test');
const id = '12345678-1234-4234-9234-123456789012';
const token = 'a'.repeat(64);
const customerUrl = '/linear-barcode.html#request=' + id + '&token=' + token;
async function stub(page, options = {}) {
  await page.route('https://cdn.jsdelivr.net/**', r => r.abort());
  await page.route('https://fonts.googleapis.com/**', r => r.abort());
  await page.route('https://fonts.gstatic.com/**', r => r.abort());
  await page.addInitScript(({ options, id }) => {
    window.__CALLS__ = [];
    let submitted = !!options.submitted;
    let creates = 0;
    const request = { id, sync_pending: !!options.syncPending, integrations: options.syncPending ? [{provider:'linear',pending:true,error:'Provider unavailable'}] : [], expires_at: options.syncPending ? '2099-01-01' : undefined, mode: 'shadow', company_name: 'Acme', contact_name: 'Dana', contact_email: 'dana@acme.example',
      quote_name: 'quote.pdf', quote_version: 1, barcode_type: 'linear', request_state: options.pending ? 'draft' : 'ready',
      customer_url: location.origin + '/linear-barcode.html#request=' + id + '&token=' + 'a'.repeat(64) };
    const client = {
      auth: {
        getSession: async () => ({ data: { session: options.signedOut ? null : { user: { email: options.email || 'graham.cooper@toolhound.com' } } } }),
        signInWithOtp: async args => { window.__CALLS__.push(args); return {}; },
        signOut: async () => ({})
      },
      functions: { invoke: async (name, { body }) => {
        window.__CALLS__.push(body);
        if(body.action==='list' && options.holdList) return await new Promise(resolve=>{window.__finishList=(fail)=>resolve(fail?{data:{error:'Connection failed'}}:{data:{requests:[request]}});});
        if (body.action === 'mark_sent' && options.holdMark) return await new Promise(resolve => { window.__finishMark = fail => resolve(fail ? {data:{error:'Save failed. Retry.'}} : {data:{ok:true}}); });
        if (body.action === 'quote') return {data:{quote_name:'quote.pdf',quote_data:btoa('%PDF-1.7\n%%EOF')}};
        if (options.failLoad && body.action === 'load') return { data: { error: 'Invalid customer link' } };
        if (body.action === 'load') return { data: { barcode_type: options.wrongVariant ? 'qr' : 'linear', mode: 'shadow',
          submitted_at: submitted ? '2026-10-19T12:00:00Z' : null, order_ref: submitted ? 'THL-EXISTING' : null,
          prefill: { companyName: 'Acme', contactName: 'Dana', contactEmail: 'dana@acme.example', internal_notes: 'PRIVATE' } } };
        if (body.action === 'submit') { submitted = true; return { data: { mode: 'shadow', submitted_at: '2026-10-19T12:00:00Z', order_ref: 'THL-EXISTING' } }; }
        if (body.action === 'regenerate') { request.expires_at = '2099-01-01'; request.token_version = 2; request.customer_url = request.customer_url.replace('a'.repeat(64), 'b'.repeat(64)); return { data: request }; }
        if (body.action === 'list' && options.history) return { data: { requests: [{ ...request, expires_at: request.expires_at || (options.pending ? '2099-01-01' : '2020-01-01'), token_version: request.token_version || 1, sent_at: options.unsent ? null : '2020-01-01', sent_recipient: request.contact_email, submitted_at: options.submitted ? '2026-10-19T12:00:00Z' : null }] } };
        if (body.action === 'list') return { data: { requests: options.pending ? [{ ...request, request_state: 'draft', sync_pending: true }] : [] } };
        if (body.action === 'create') { creates++; if (options.failFirst && creates === 1) return { data: { error: 'Uncertain create' } }; return { data: request }; }
        if (body.action === 'recover') { request.request_state = 'ready'; return { data: request }; }
        return { data: { ok: true } };
      } },
      from: () => ({ select: () => ({ order: async () => ({ data: [] }) }), insert: () => { throw new Error('Invitations must never use a direct customer insert'); } })
    };
    window.__TOOLHOUND_CLIENT__ = client;
    window.__TOOLHOUND_DB__ = client;
  }, { options, id });
}
test('intake requires sign in and rejects lookalike work domains', async ({page}) => {
  await stub(page, { signedOut: true }); await page.goto('/prepare-order.html');
  await page.getByLabel('Work email').fill('intruder@toolhound.com.evil.example');
  await page.getByRole('button', {name:'Send sign-in link'}).click();
  await expect(page.getByText('Enter an authorized Beacon email address or Graham’s ToolHound address.')).toBeVisible();
  expect(await page.evaluate(() => window.__CALLS__)).toEqual([]);
});
for (const email of ['graham.cooper@toolhound.com', 'steve@beaconsoftware.com']) {
  test('intake allows ' + email, async ({ page }) => {
    await stub(page, {email}); await page.goto('/prepare-order.html');
    await expect(page.getByRole('heading', {name:'New customer request'})).toBeVisible();
  });
}
test('requires PDF and reuses request ID after an uncertain creation', async ({ page }) => {
  await stub(page, {failFirst: true}); await page.goto('/prepare-order.html');
  await page.getByLabel('Company name *').fill('Acme');
  await page.getByLabel('Contact name *').fill('Dana');
  await page.getByLabel('Contact email *').fill('dana@acme.example');
  await page.getByLabel('Label order type *').selectOption('linear');
  await page.locator('#orderPreparation').getByRole('button', {name:'Prepare customer link'}).click();
  expect((await page.evaluate(() => window.__CALLS__)).filter(c => c.action === 'create')).toHaveLength(0);
  await page.getByLabel('Completed quote PDF *').setInputFiles({name:'quote.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF-1.7\n%%EOF')});
  await page.locator('#orderPreparation').getByRole('button', {name:'Prepare customer link'}).click();
  await expect(page.getByText(/Uncertain create/)).toBeVisible();
  await page.locator('#orderPreparation').getByRole('button', {name:'Prepare customer link'}).click();
  await expect(page.getByRole('textbox', {name:'Customer link',exact:true})).toHaveValue(/#request=/);
  const calls = (await page.evaluate(() => window.__CALLS__)).filter(c => c.action === 'create');
  expect(calls).toHaveLength(2); expect(calls[0].id).toBe(calls[1].id);
  await page.getByRole('button', {name:'Mark form sent'}).click();
  await expect(page.getByText('Marked sent. Delivery has not been verified.')).toBeVisible();
});
test('customer link prefills only permitted fields', async ({page}) => {
  await stub(page); await page.goto(customerUrl);
  await expect(page.getByLabel('Company Name *')).toHaveValue('Acme');
  await expect(page.getByLabel('Customer Contact Name *')).toHaveValue('Dana');
  await expect(page.getByLabel('Customer Contact Email *')).toHaveValue('dana@acme.example');
  expect(await page.evaluate(() => window.__TOOLHOUND_FORM__.state.data.internal_notes)).toBeUndefined();
  await expect(page.getByText('PRIVATE')).toHaveCount(0);
});
for (const options of [{failLoad:true}, {wrongVariant:true}, {submitted:true}]) {
  test('customer cannot submit invalid, mismatched or completed link ' + JSON.stringify(options), async ({page}) => {
    await stub(page, options); await page.goto(customerUrl);
    await expect(page.getByLabel('Company Name *')).toHaveCount(0);
    await expect(page.getByRole('button', {name:'Submit Order'})).toHaveCount(0);
    await expect(page.getByText(options.submitted ? /Test response recorded/ : options.wrongVariant ? /different label form/ : /Invalid customer link/)).toBeVisible();
  });
}
test('linked submission uses request endpoint and returns an immutable receipt', async ({page}) => {
  await stub(page); await page.goto(customerUrl);
  await expect(page.getByLabel('Company Name *')).toHaveValue('Acme');
  await page.evaluate(() => {
    const f = window.__TOOLHOUND_FORM__;
    Object.assign(f.state.data, { address:'1 Main',city:'Toronto',stateProvince:'ON',postalCode:'M1M 1M1',country:'Canada',
      logoChoice:'serial_only',fullColor:'No',quantity:'3000',seqStart:'001',labelType:'premium_poly_pro',labelWidthIn:'1.5',labelHeightIn:'.75' });
    f.state.step = 3; f.render();
  });
  await page.getByLabel('Authorized Name *').fill('Dana');
  await page.getByLabel('Type your name to sign').fill('Dana');
  await page.getByLabel('I have read and agree').check();
  await page.getByRole('button', {name:'Submit Order'}).click();
  await expect(page.getByText('Test response recorded')).toBeVisible();
  await expect(page.getByText('Reference: THL-EXISTING')).toBeVisible();
  const submit = (await page.evaluate(() => window.__CALLS__)).filter(c=>c.action==='submit');
  expect(submit).toHaveLength(1); expect(submit[0].id).toBe(id); expect(submit[0].token).toBe(token);
  await expect(page.getByRole('button', {name:'Submit Order'})).toHaveCount(0);
});
for (const path of ['/linear-barcode.html', '/qr-code.html', '/linear-barcode.html#request=missing-token', '/qr-code.html#token=missing-request']) {
  test('redirects customer without a complete link: ' + path, async ({page}) => {
    await stub(page); await page.goto(path);
    await expect(page).toHaveURL(/\/request-link\.html$/);
    await expect(page.getByRole('heading', {name:'Get your order link'})).toBeVisible();
    await expect(page.getByRole('link', {name:'graham.cooper@toolhound.com'})).toHaveAttribute('href','mailto:graham.cooper@toolhound.com');
    await expect(page.getByLabel('Company Name *')).toHaveCount(0);
  });
}

test('admin and preparation have distinct routes that survive reload and back navigation', async ({page}) => {
  await stub(page);
  await page.goto('/admin.html');
  await expect(page.getByRole('heading', {name:'Label orders', exact:true})).toBeVisible();
  await page.getByRole('link', {name:'Prepare customer link', exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/prepare-order$/);
  await expect(page.getByRole('link', {name:'Prepare customer link', exact:true})).toHaveAttribute('aria-current','page');
  await page.reload();
  await expect(page.getByLabel('Company name *')).toBeVisible();
  await page.getByLabel('Company name *').fill('Draft company');
  await page.getByRole('link', {name:'Label orders', exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByRole('heading', {name:'Label orders', exact:true})).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Company name *')).toHaveValue('Draft company');
  await page.goto('/admin.html?view=prepare');
  await expect(page).toHaveURL(/\/admin\/prepare-order$/);
});

test('history regenerates an expired request and displays the replacement link', async ({page}) => {
 await stub(page,{history:true}); await page.goto('/prepare-order.html');
 await expect(page.getByRole('columnheader',{name:'Last sent',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Regenerate link',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Customer link',exact:true})).toHaveValue(new RegExp('token='+'b'.repeat(64)));
 expect((await page.evaluate(()=>window.__CALLS__)).filter(c=>c.action==='regenerate')).toEqual([{action:'regenerate',id,token_version:1}]);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await expect(page.getByRole('button',{name:'Regenerate link',exact:true})).toHaveCount(0);
});
test('submitted requests appear in history without regeneration', async ({page}) => {
 await stub(page,{history:true,submitted:true}); await page.goto('/prepare-order.html');
 await expect(page.getByText('Submitted:',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Regenerate link',exact:true})).toHaveCount(0);
});

test('quote filename links to a separate authenticated PDF viewer', async ({page}) => {
 await stub(page,{history:true}); await page.goto('/prepare-order.html');
 const link=page.getByRole('link',{name:'quote.pdf',exact:true});
 await expect(link).toHaveAttribute('target','_blank');
 await expect(link).toHaveAttribute('href','/quote.html?request='+id);

});
test('quote viewer requires sign-in before fetching the PDF', async ({page}) => {
 await stub(page,{signedOut:true});await page.goto('/quote.html?request='+id);
 await expect(page.getByRole('status')).toHaveText('Sign in to admin in this browser, then reload this quote.');
 expect(await page.evaluate(()=>window.__CALLS__)).toEqual([]);
});

for (const fail of [false, true]) {
 test('mark sent updates immediately and ' + (fail ? 'rolls back on error' : 'keeps confirmed state'), async ({page}) => {
  await stub(page, {history:true, unsent:true, holdMark:true});
  await page.goto('/admin.html?view=prepare');
  await page.getByRole('button',{name:'Regenerate link',exact:true}).click();
  await page.getByRole('button',{name:'Mark form sent',exact:true}).click();
  const table = page.locator('.request-table');
  await expect(table.getByText('Awaiting customer',{exact:true})).toBeVisible();
  await expect(table.getByText('Saving…',{exact:true})).toBeVisible();
  // Returning to the window must not disturb the optimistic change.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(table.getByText('Awaiting customer',{exact:true})).toBeVisible();
  await page.evaluate(fail => window.__finishMark(fail), fail);
  await expect(page.getByText(fail ? 'Save failed. Retry.' : 'Marked sent. Delivery has not been verified.',{exact:true})).toBeVisible();
  await expect(table.getByText(fail ? 'Not marked sent' : 'Awaiting customer',{exact:true})).toBeVisible();
  await expect(table.getByText('Saving…',{exact:true})).toHaveCount(0);
 });
}

test('recovery replaces the incomplete row without a manual refresh', async ({page}) => {
 await stub(page, {history:true, pending:true});
 await page.goto('/admin.html?view=prepare');
 await page.getByRole('button',{name:'Retry preparation',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.locator('.request-table').getByText('Preparation incomplete',{exact:true})).toHaveCount(0);
 await expect(page.locator('.request-table').getByRole('button',{name:'Retry preparation',exact:true})).toHaveCount(0);
});

test('pending external sync leaves link available and remains pending after a failed retry',async({page})=>{
 await stub(page,{history:true,syncPending:true});await page.goto('/admin.html?view=prepare');
 await expect(page.getByText('Sync pending · link is usable')).toBeVisible();
 await page.getByRole('button',{name:'Retry sync',exact:true}).click();
 await expect(page.getByText('Sync pending · link is usable')).toBeVisible();
 await page.getByRole('button',{name:'Show link',exact:true}).click();
 await expect(page.getByText('Customer link is ready. External sync is pending; you can send the link now.')).toBeVisible();
 await expect(page.getByRole('link',{name:'Open customer form'})).toHaveAttribute('href',/request=/);
});

test('request table shows loading, retains rows during refresh and clears indicator on failure',async({page})=>{
 await stub(page,{holdList:true});await page.goto('/admin.html?view=prepare');
 await expect(page.getByText('Loading requests…',{exact:true})).toBeVisible();
 await expect(page.getByText('No requests yet.',{exact:false})).not.toBeVisible();
 await expect(page.locator('.request-table-scroll')).toHaveAttribute('aria-busy','true');
 await page.evaluate(()=>window.__finishList(false));
 await expect(page.getByText('Loading requests…',{exact:true})).not.toBeVisible();
 await expect(page.getByRole('cell',{name:'Acme Dana dana@acme.example'})).toBeVisible();
 await page.getByRole('button',{name:'Refresh requests',exact:true}).click();
 await expect(page.getByText('Refreshing requests…',{exact:true})).toBeVisible();
 await expect(page.getByRole('cell',{name:'Acme Dana dana@acme.example'})).toBeVisible();
 await page.evaluate(()=>window.__finishList(true));
 await expect(page.getByText('Could not refresh requests. Connection failed')).toBeVisible();
 await expect(page.locator('.request-table-scroll')).toHaveAttribute('aria-busy','false');
 await expect(page.getByRole('button',{name:'Refresh requests',exact:true})).toBeEnabled();
});

 test('requests do not poll or refresh on window focus', async ({page}) => {
  await page.clock.install();
  await stub(page, {history:true});
  await page.goto('/prepare-order.html');
  await expect(page.getByRole('button', {name:'Refresh requests',exact:true})).toBeEnabled();
  const before = await page.evaluate(() => window.__CALLS__.filter(c => c.action === 'list').length);
  expect(before).toBe(1);
  await page.clock.fastForward(60000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.evaluate(() => window.__CALLS__.filter(c => c.action === 'list').length)).toBe(before);
  await page.getByRole('button', {name:'Refresh requests',exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.__CALLS__.filter(c => c.action === 'list').length)).toBe(before + 1);
 });

for (const [source, destination] of [
 ['/admin','/admin/orders'], ['/admin/','/admin/orders'], ['/admin.html','/admin/orders'],
 ['/prepare-order','/admin/prepare-order'], ['/prepare-order.html','/admin/prepare-order'],
 ['/admin.html?view=prepare','/admin/prepare-order'],
 ['/admin/orders','/admin/orders'], ['/admin/prepare-order','/admin/prepare-order']
]) {
 test('canonical admin route: '+source, async ({page}) => {
  await stub(page, {signedOut:true});
  const missing=[]; page.on('response',r=>{if(r.status()===404)missing.push(r.url());});
  await page.goto(source+'#request=bookmark');
  expect(new URL(page.url()).pathname).toBe(destination);
  expect(new URL(page.url()).hash).toBe('#request=bookmark');
  await expect(page.getByRole('heading',{name:'Sign in to label orders'})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Work email')).toBeVisible();
  expect(missing).toEqual([]);
 });
}
