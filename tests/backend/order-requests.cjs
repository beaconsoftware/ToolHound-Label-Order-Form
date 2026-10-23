const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
let db;
const staff = '10000000-0000-4000-8000-000000000001';
const request = '20000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
const row = {
  company_name:'Acme',contact_name:'Dana',contact_email:'dana@acme.example',address:'1 Main',city:'Toronto',
  state_province:'ON',postal_code:'M1M 1M1',country:'Canada',barcode_type:'qr',logo_choice:'serial_only',
  full_color:'No',quantity:3000,seq_start:'001',label_type:'premium_poly_pro',label_width_in:1.5,label_height_in:.75,
  authorized_name:'Dana',approval_date:'2026-10-19',signature_data:'data:image/png;base64,aGVsbG8='
};
before(async()=>{
 db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(bucket_id text,name text); alter table storage.objects enable row level security; create schema auth; create table auth.users (id uuid primary key,email text,raw_app_meta_data jsonb,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz,is_anonymous boolean default false);`);
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
   if(file.endsWith('_provider_independent_orders.sql')) {
     await db.exec("insert into auth.users(id,email,raw_app_meta_data) values ('10000000-0000-4000-8000-000000000099','migration@toolhound.com','{}'); insert into public.order_requests(id,created_by,mode,company_name,contact_name,contact_email,barcode_type,quote_name,quote_sha256,quote_data,token_hash,ticket_state,linear_identifier,linear_url) values ('20000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000099','live','Legacy','Dana','dana@acme.example','linear','old.pdf','oldhash','JVBERi0xLjQ=','legacy-token','ready','SALES-418','https://linear.app/example');");
   }
   if(file.endsWith('_consolidate_order_requests.sql')) {
    await db.exec(`select public.create_order_request('{"id":"20000000-0000-4000-8000-000000000098","created_by":"10000000-0000-4000-8000-000000000099","mode":"live","company_name":"Pending","contact_name":"Dana","contact_email":"dana@acme.example","barcode_type":"linear","token_hash":"pending-token"}', '{"name":"pending.pdf","sha256":"pendinghash","data_base64":"JVBERi0xLjQ="}');
     update public.integration_jobs set attempts=3,last_error='Provider unavailable',available_at='2099-01-01' where request_id='20000000-0000-4000-8000-000000000098';`);
   }
   try { await db.exec(fs.readFileSync(path.join('supabase/migrations',file),'utf8')); }
   catch(e) { throw new Error(file + ': ' + e.message); }
 }
 await db.exec('grant all on public.label_orders to service_role; grant usage on schema public to service_role,anon,authenticated;');
 await db.query('insert into auth.users(id,email,raw_app_meta_data) values ($1,$2,$3)',[staff,'graham@toolhound.com','{}']);
});
after(async()=>{await db?.close();});
async function seed(id=request, mode='live', ticket='ready', provider='linear') {
 await db.query('select public.create_order_request($1,$2,$3)',[JSON.stringify({id,created_by:staff,mode,company_name:'Acme',contact_name:'Dana',contact_email:'dana@acme.example',barcode_type:'linear',token_hash:id===request?digest:id}),JSON.stringify({name:'quote.pdf',sha256:'hash',data_base64:'JVBERi0xLjQ='}),provider]);
 if(ticket!=='ready') await db.query('update public.order_requests set request_state=$2 where id=$1',[id,ticket]);
}
async function submit(id=request, token=digest, values=row) {
 return (await db.query('select public.submit_order_request($1,$2,$3) as receipt',[id,token,JSON.stringify(values)])).rows[0].receipt;
}
test('all migrations apply; invitation produces one signed order and repeat is immutable',async()=>{
 await seed();
 const first=await submit();
 const second=await submit(request,digest,{...row,quantity:9000});
 assert.equal(first.order_ref,'1001');
 assert.equal(first.order_ref,second.order_ref); assert.equal(second.already_submitted,true);
 const orders=(await db.query('select * from public.label_orders')).rows;
 assert.equal(orders.length,1); assert.equal(orders[0].quantity,3000); assert.equal(orders[0].barcode_type,'linear');
 const r=(await db.query('select * from public.order_requests where id=$1',[request])).rows[0];
 assert.equal(orders[0].order_request_id,r.id); assert.equal(r.external_sync['order.submitted'].status,'pending');
});
test('anonymous inserts are denied while server token submissions still work',async()=>{
 await db.exec('set role anon');
 try {
  await assert.rejects(()=>db.query('insert into public.label_orders default values'),/permission denied/);
 } finally { await db.exec('reset role'); }
 const id='20000000-0000-4000-8000-000000000077';
 await seed(id);
 await db.exec('set role service_role');
 try {
  const receipt=await submit(id,id);
  assert.ok(receipt.order_ref);
 } finally { await db.exec('reset role'); }
});
test('tampered tokens cannot read or submit another request',async()=>{
 await assert.rejects(()=>submit(request,'b'.repeat(64)),/Invalid link/);
});
test('bad order validation rolls back the request and order together',async()=>{
 const id='20000000-0000-4000-8000-000000000002'; await seed(id);
 await assert.rejects(()=>submit(id,id,{...row,quantity:-1}));
 const r=(await db.query('select shadow_receipt from public.order_requests where id=$1',[id])).rows[0];
 assert.equal(r.shadow_receipt,null); assert.equal((await db.query('select id from public.label_orders where order_request_id=$1',[id])).rows.length,0);
});
test('draft requests and expired links cannot submit',async()=>{
 const id='20000000-0000-4000-8000-000000000003'; await seed(id,'live','draft');
 await assert.rejects(()=>submit(id,id),/Invalid link/);
 await db.query("update public.order_requests set request_state='ready',expires_at=now()-interval '1 day' where id=$1",[id]);
 await assert.rejects(()=>submit(id,id),/Expired link/);
});
test('shadow response stays out of production orders',async()=>{
 const id='20000000-0000-4000-8000-000000000004'; await seed(id,'shadow');
 const receipt=await submit(id,id); assert.equal(receipt.mode,'shadow');
 const r=(await db.query('select shadow_receipt from public.order_requests where id=$1',[id])).rows[0];
 assert.equal((await db.query('select id from public.order_requests where id=$1 and external_provider is not null',[id])).rows.length,0);assert.ok(r.shadow_receipt.submitted_at);
});
test('public and staff browser roles cannot read invitations or call the privileged submit function',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  await assert.rejects(()=>db.query('select * from public.order_requests'),/permission denied/);
  await assert.rejects(()=>submit(),/permission denied/);
  await db.exec('reset role');
 }
});

test('expired link regeneration preserves request, rejects old token, and retries safely',async()=>{
 const id='20000000-0000-4000-8000-000000000006'; await seed(id);
 await db.query("update public.order_requests set expires_at=now()-interval '1 day' where id=$1",[id]);
 await db.query('select public.regenerate_order_request($1,1,$2)',[id,'newhash']);
 await db.query('select public.regenerate_order_request($1,1,$2)',[id,'newhash']);
 const r=(await db.query('select * from public.order_requests where id=$1',[id])).rows[0];
 assert.equal(r.token_version,2);assert.equal(r.token_hash,'newhash');assert.equal(r.company_name,'Acme');
 await assert.rejects(()=>submit(id,id),/Invalid link/);
 await submit(id,'newhash');
 await assert.rejects(()=>db.query('select public.regenerate_order_request($1,2,$2)',[id,'thirdhash']),/Already submitted/);
 await assert.rejects(()=>db.query('delete from public.label_orders where order_request_id=$1',[id]),/Cancel this linked order/);
});
test('active links cannot be regenerated and browser roles cannot rotate links',async()=>{
 const id='20000000-0000-4000-8000-000000000007';await seed(id);
 await assert.rejects(()=>db.query('select public.regenerate_order_request($1,1,$2)',[id,'replacement']),/still active/);
 await db.exec('set role authenticated');
 await assert.rejects(()=>db.query('select public.regenerate_order_request($1,1,$2)',[id,'replacement']),/permission denied/);
 await db.exec('reset role');
});

test('integration leases serialize workers, enforce creation before submission, and reject stale completion',async()=>{
 const id='20000000-0000-4000-8000-000000000010';await seed(id);await submit(id,id);
 const claim=async()=> (await db.query("select * from public.claim_order_sync($1,'linear')",[id])).rows;
 const first=(await claim())[0];assert.equal(first.event,'request.created');
 assert.equal((await claim()).length,0);
 await db.query('select public.finish_order_sync($1,$2,$3,null)',[first.id,first.event,'00000000-0000-4000-8000-000000000000']);
 assert.equal((await claim()).length,0);
 await db.query("update public.order_requests set external_sync=jsonb_set(external_sync,'{request.created,lease_until}',to_jsonb(now()-interval '1 second')) where id=$1",[first.id]);
 const reclaimed=(await claim())[0];assert.notEqual(reclaimed.claim_token,first.claim_token);
 await db.query('select public.finish_order_sync($1,$2,$3,null)',[first.id,first.event,first.claim_token]);
 assert.equal((await claim()).length,0);
 await db.query('select public.finish_order_sync($1,$2,$3,null)',[reclaimed.id,reclaimed.event,reclaimed.claim_token]);
 const next=(await claim())[0];assert.equal(next.event,'order.submitted');
 await db.query('select public.finish_order_sync($1,$2,$3,$4)',[next.id,next.event,next.claim_token,'Provider unavailable']);
 assert.equal((await claim()).length,0);
 await db.query('select public.retry_order_integrations($1)',[id]);assert.equal((await claim())[0].event,'order.submitted');
});
test('creation is atomic, retries preserve documents, and disabling providers leaves orders usable',async()=>{
 const id='20000000-0000-4000-8000-000000000011';

 await seed(id,'live','ready',null);await seed(id,'live','ready',null);
 assert.equal((await db.query('select quote_data from public.order_requests where id=$1',[id])).rows[0].quote_data,'JVBERi0xLjQ=');
 assert.equal((await db.query('select id from public.order_requests where id=$1 and external_provider is not null',[id])).rows.length,0);
 assert.ok((await submit(id,id)).order_ref);

 const bad='20000000-0000-4000-8000-000000000012';
 await assert.rejects(()=>db.query('select public.create_order_request($1,$2,$3)',[JSON.stringify({id:bad,created_by:staff,mode:'live',company_name:'Acme',contact_name:'Dana',contact_email:'dana@acme.example',barcode_type:'linear',token_hash:bad}),JSON.stringify({name:'quote.pdf',sha256:'hash',data_base64:''}),'linear']));
 assert.equal((await db.query('select id from public.order_requests where id=$1',[bad])).rows.length,0);
});
test('private request data and sync RPCs are inaccessible to browser roles',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  for(const table of ['order_requests']) await assert.rejects(()=>db.query('select * from public.'+table),/permission denied/);
  await assert.rejects(()=>db.query("select * from public.claim_order_sync($1,'linear')",[request]),/permission denied/);
  await db.exec('reset role');
 }
});

test('migration preserves existing identity, token, quote and external ticket mapping',async()=>{
 const id='20000000-0000-4000-8000-000000000099';
 const r=(await db.query('select * from public.order_requests where id=$1',[id])).rows[0];
 assert.equal(r.token_hash,'legacy-token');assert.equal(r.request_state,'ready');
 assert.ok(!Object.keys(r).some(k=>k.startsWith('linear_')));
 assert.equal(r.quote_name,'old.pdf');assert.equal(r.quote_data,'JVBERi0xLjQ=');
 const e=(await db.query('select * from public.order_requests where id=$1',[id])).rows[0];assert.equal(e.external_identifier,'SALES-418');
 assert.equal(e.external_sync['request.created'].status,'succeeded');
});

test('auxiliary tables are removed',async()=>{
 for(const table of ['external_records','integration_jobs','order_documents','order_integration_providers']) assert.equal((await db.query('select to_regclass($1) t',['public.'+table])).rows[0].t,null);
});

test('migration preserves pending retry state and wrong providers cannot claim it',async()=>{
 const id='20000000-0000-4000-8000-000000000098';
 const r=(await db.query('select * from public.order_requests where id=$1',[id])).rows[0];
 assert.equal(r.quote_name,'pending.pdf');assert.equal(r.token_hash,'pending-token');
 const sync=r.external_sync['request.created'];assert.equal(sync.attempts,3);assert.equal(sync.last_error,'Provider unavailable');assert.equal(sync.status,'pending');
 assert.equal((await db.query("select * from public.claim_order_sync($1,'linear')",[id])).rows.length,0);
 await db.query('select public.retry_order_integrations($1)',[id]);
 assert.equal((await db.query("select * from public.claim_order_sync($1,'other')",[id])).rows.length,0);
 assert.equal((await db.query("select * from public.claim_order_sync($1,'linear')",[id])).rows.length,1);
});

test('staff RLS checks current verified identity, ignores forged email and metadata',async()=>{
 const id='10000000-0000-4000-8000-000000000088';
 await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'audit@beaconsoftware.com',now())",[id]);
 async function allowed(email,extra={}) {
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:id,email,...extra})]);
  await db.exec('set role authenticated');
  try { return (await db.query('select public.is_label_order_staff() ok')).rows[0].ok; }
  finally { await db.exec('reset role'); }
 }
 assert.equal(await allowed('audit@beaconsoftware.com'),true);
 await db.query("update auth.users set email='other@toolhound.com' where id=$1",[id]);
 assert.equal(await allowed('audit@beaconsoftware.com'),false);
 assert.equal(await allowed('other@toolhound.com',{user_metadata:{email:'audit@beaconsoftware.com'}}),false);
 await db.query("update auth.users set email='graham.cooper@toolhound.com' where id=$1",[id]);
 assert.equal(await allowed('graham.cooper@toolhound.com'),true);
 await db.query('update auth.users set email_confirmed_at=null where id=$1',[id]);
 assert.equal(await allowed('graham.cooper@toolhound.com'),false);
 await db.query("update auth.users set email_confirmed_at=now(),banned_until=now()+interval '1 day' where id=$1",[id]);
 assert.equal(await allowed('graham.cooper@toolhound.com'),false);
 await db.query('update auth.users set banned_until=null,deleted_at=now() where id=$1',[id]);
 assert.equal(await allowed('graham.cooper@toolhound.com'),false);
 await db.query('update auth.users set deleted_at=null,is_anonymous=true where id=$1',[id]);
 assert.equal(await allowed('graham.cooper@toolhound.com'),false);
 await db.exec('set role anon');
 try { await assert.rejects(()=>db.query('select public.is_label_order_staff()'),/permission denied/); }
 finally { await db.exec('reset role'); }
});

test('request creation persists origin atomically and retries cannot change it',async()=>{
 const id='20000000-0000-4000-8000-000000000087';
 const request={id,created_by:staff,mode:'shadow',company_name:'Test',contact_name:'Test',contact_email:'test@example.com',barcode_type:'linear',token_hash:'origin-test',app_origin:'http://localhost:4175'};
 const quote={name:'test.pdf',sha256:'hash',data_base64:'JVBERi0xLjQ='};
 await db.query('select public.create_order_request($1,$2,null)',[JSON.stringify(request),JSON.stringify(quote)]);
 await db.query('select public.create_order_request($1,$2,null)',[JSON.stringify({...request,app_origin:'https://production.example'}),JSON.stringify(quote)]);
 assert.equal((await db.query('select app_origin from public.order_requests where id=$1',[id])).rows[0].app_origin,'http://localhost:4175');
});

test('previous reference PDF is atomic and cannot be replaced by a retried creation',async()=>{
 const id='20000000-0000-4000-8000-000000000086';
 const request={id,created_by:staff,mode:'shadow',company_name:'Test',contact_name:'Test',contact_email:'test@example.com',barcode_type:'linear',token_hash:'previous-test',previous_order_name:'old.pdf',previous_order_data:'JVBERi0xLjQ='};
 const quote={name:'test.pdf',sha256:'hash',data_base64:'JVBERi0xLjQ='};
 await db.query('select public.create_order_request($1,$2,null)',[JSON.stringify(request),JSON.stringify(quote)]);
 await db.query('select public.create_order_request($1,$2,null)',[JSON.stringify({...request,previous_order_name:'replacement.pdf'}),JSON.stringify(quote)]);
 assert.deepEqual((await db.query('select previous_order_name,previous_order_data from public.order_requests where id=$1',[id])).rows[0],{previous_order_name:'old.pdf',previous_order_data:'JVBERi0xLjQ='});
 await assert.rejects(()=>db.query('update public.order_requests set previous_order_data=null where id=$1',[id]),/previous_order_pdf_pair/);
});

test('PO persists immutably and concurrent requests receive distinct numeric numbers',async()=>{
 const ids=['20000000-0000-4000-8000-000000000081','20000000-0000-4000-8000-000000000082'];
 for(const id of ids) await seed(id);
 const receipts=await Promise.all(ids.map(id=>submit(id,id,{...row,customer_po:' PO-12345 '})));
 assert.equal(Number(receipts[1].order_ref),Number(receipts[0].order_ref)+1);
 for(let i=0;i<ids.length;i++){
  assert.match(receipts[i].order_ref,/^[0-9]+$/);
  const retry=await submit(ids[i],ids[i],{...row,customer_po:'CHANGED'});
  assert.equal(retry.order_ref,receipts[i].order_ref);
  assert.equal((await db.query('select customer_po from public.label_orders where order_request_id=$1',[ids[i]])).rows[0].customer_po,'PO-12345');
 }
 const id='20000000-0000-4000-8000-000000000083';await seed(id);
 await assert.rejects(()=>submit(id,id,{...row,customer_po:'x'.repeat(65)}),/64 characters/);
 await db.exec('set role anon');
 try {await assert.rejects(()=>db.query("select nextval('public.label_order_number_seq')"),/permission denied/);}
 finally{await db.exec('reset role');}
});

test('every production test scenario satisfies the real order constraints',async()=>{
 const vm=require('node:vm'),{stripTypeScriptTypes}=require('node:module');
 const context={};vm.createContext(context);
 vm.runInContext(stripTypeScriptTypes(fs.readFileSync('supabase/functions/order-requests/test-runner.ts','utf8').replace(/^export /gm,'')),context);
 let n=200;
 for(const barcode of ['linear','qr']) for(const artwork of ['toolhound_logo','custom_logo','custom_text','serial_only'])
 for(const material of ['premium_poly_pro','white_polypropylene','anodized_aluminum_3mil']) for(const po of [true,false])
 for(const colour of (['custom_text','serial_only'].includes(artwork)?[false]:[true,false])){
  const fixture=context.testOrderFixture({barcode,artwork,material,po,colour});
  const id='20000000-0000-4000-8000-'+String(n++).padStart(12,'0');
  await seed(id);
  const result=await submit(id,id,fixture.row);
  assert.match(result.order_ref,/^[0-9]+$/);
 }
});

test('stored artwork references survive submission, reject another order path, and retain private read policy',async()=>{
 const id='20000000-0000-4000-8000-000000000901';await seed(id);
 await db.query("update public.order_requests set barcode_type='qr' where id=$1",[id]);
 const artwork={...row,logo_choice:'custom_logo',text_lines:null,logo_file_name:'original.png',logo_file_data:null,logo_storage_path:id+'/'+ 'a'.repeat(64)+'.png'};
 await assert.rejects(()=>submit(id,id,{...artwork,logo_storage_path:'20000000-0000-4000-8000-000000000902/'+'a'.repeat(64)+'.png'}),/storage_path_valid/);
 await submit(id,id,artwork);
 const saved=(await db.query('select logo_file_data,logo_storage_path from public.label_orders where order_request_id=$1',[id])).rows[0];
 assert.equal(saved.logo_file_data,null);assert.equal(saved.logo_storage_path,artwork.logo_storage_path);
 const bucket=(await db.query("select * from storage.buckets where id='order-artwork'")).rows[0];
 assert.equal(bucket.public,false);assert.equal(Number(bucket.file_size_limit),4194304);
 const policies=(await db.query("select cmd,roles,qual from pg_policies where schemaname='storage' and tablename='objects'")).rows;
 assert.equal(policies.length,1);assert.equal(policies[0].cmd,'SELECT');assert.match(policies[0].qual,/is_label_order_staff/);assert.match(policies[0].qual,/logo_storage_path/);
});
