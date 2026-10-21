const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto } = require('node:crypto');
const id = '20000000-0000-4000-8000-000000000001';
function runtime(options = {}) {
 const rows = new Map(); const issues = new Map(); const events = []; let handler; let lose = !!options.loseCreate;
 const env = { SUPABASE_URL:'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'private', ORDER_APP_URL:'https://orders.example',
  ORDER_ALLOWED_ORIGINS:options.origins||'',ORDER_LINK_SECRET:'test-secret-with-at-least-32-characters',ORDER_REQUESTS_MODE:options.mode || 'live',
  ORDER_INTEGRATION_PROVIDER:options.disabled?'none':options.provider,LINEAR_LABEL_ORDER_TEMPLATE_ID:options.templateId,LINEAR_API_KEY:'private-linear',LINEAR_TEAM_ID:'team',LINEAR_INTAKE_STATE_ID:'state' };
 const jobs = new Map(), tasks = [];
 const db={auth:{getUser:async token=>({data:{user:token==='staff'?{id:'staff', email:options.email||'graham.cooper@toolhound.com',email_confirmed_at:options.unconfirmed?null:'2026-01-01'}:null},error:token!=='staff'})},
 rpc: async (name,args)=>{
  if(name==='is_label_order_staff') {
   const address=(options.email || 'graham.cooper@toolhound.com').toLowerCase();
   return {data:!options.denied && (address.split('@')[1]==='beaconsoftware.com' || address==='graham.cooper@toolhound.com'),error:options.authRpcError};
  }
  if(name==='regenerate_order_request') {
   Object.assign(rows.get(args.p_id),{token_version:args.p_version+1,token_hash:args.p_token_hash});return {data:null};
  }
  if(name==='create_order_request') {
   const v=args.p_request;
   if(!rows.has(v.id)) {
    rows.set(v.id,{...v,request_state:'ready',quote_version:1,token_version:1,created_at:new Date().toISOString(),expires_at:'2099-01-01',submitted_at:null});
    Object.assign(rows.get(v.id),{quote_name:args.p_quote.name,quote_data:args.p_quote.data_base64,quote_sha256:args.p_quote.sha256,external_sync:{}});
    if(v.mode==='live' && args.p_provider) {
     Object.assign(rows.get(v.id),{external_provider:'linear',external_id:'30000000-0000-4000-8000-000000000001',external_metadata:{}});
     jobs.set(v.id,{id:v.id,request_id:v.id,provider:'linear',event:'request.created',status:'pending'});
    }
   }
   return {data:v.id};
  }
  if(name==='claim_order_sync') {
   const j=jobs.get(args.p_request_id);
   if(!j || j.status!=='pending' || j.backoff) return {data:[]};
   Object.assign(j,{status:'processing',claim_token:'claim'});return {data:[{...j}]};
  }
  if(name==='finish_order_sync') {
   const j=jobs.get(args.p_id);Object.assign(j,{status:args.p_error?'pending':'succeeded',last_error:args.p_error,backoff:!!args.p_error});return {data:null};
  }
  if(name==='retry_order_integrations') { const j=jobs.get(args.p_request_id);if(j)j.backoff=false;return {data:null}; }
  throw Error('Unexpected RPC '+name);
 },from:(table)=>{
  let filters=[],operation='select',values;
  const data={order_requests:rows,label_orders:new Map(options.orders || [])}[table];
  if(!data) throw Error('Unexpected table '+table);
  const q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},order:()=>q,limit:()=>q,
   maybeSingle:()=>q.then(r=>({...r,data:r.data[0]||null})),single:()=>q.then(r=>({...r,data:r.data[0]||null})),
   update:v=>{operation='update';values=v;return q;},
   then:(resolve,reject)=>Promise.resolve().then(()=>{
    const found=[...data.values()].filter(r=>filters.every(([k,v])=>r[k]===v));
    if(operation==='update') found.forEach(r=>Object.assign(r,values));
    return {data:found.map(r=>({...structuredClone(r),external_sync:jobs.has(r.id)?{'request.created':{...jobs.get(r.id)}}:{}}))};
   }).then(resolve,reject)};return q;
 }};
 async function fakeFetch(url,init) {
  events.push(url);
  if(url==='https://uploads.linear.app/vendor') {
   assert.equal(init.headers.Authorization,'private-linear');
   return new Response('%PDF-exact-uploaded-bytes');
  }
  if(url==='https://upload.example') return new Response('',{status:options.failUpload?503:200});
  const {query,variables}=JSON.parse(init.body);
  if(query.includes('fileUpload')) return Response.json({data:{fileUpload:{success:true,uploadFile:{uploadUrl:'https://upload.example',assetUrl:'https://uploads.linear.app/quote.pdf',headers:[]}}}});
  if(query.includes('issueCreate')) {
   const issue={id:variables.input.id,identifier:'TH-1',url:'https://linear.app/toolhound/issue/TH-1'};
   assert.equal(variables.input.templateId,options.templateId || 'b8be76d3-d22c-4e18-9522-1f7f4824b733');
   assert.equal(variables.input.title,'[Label Order] Acme');
   assert.equal(variables.input.assigneeId,undefined); assert.equal(variables.input.priority,undefined); assert.equal(variables.input.labelIds,undefined);
   assert.match(variables.input.description,/### Label Order Form\n\nAwaiting customer submission/);
   assert.match(variables.input.description,/### Billing Email\n\nAwaiting customer confirmation/);
   assert.equal(variables.input.teamId,'team'); assert.match(variables.input.description,/Completed quote PDF/);
   issues.set(issue.id,issue);
   if(lose){lose=false;throw new Error('Connection lost after Linear committed');}
   return Response.json({data:{issueCreate:{success:true,issue}}});
  }
  if(query.includes('issues(')) return Response.json({data:{issues:{nodes:issues.has(variables.id)?[issues.get(variables.id)]:[]}}});
  throw new Error('Unexpected outbound operation');
 }
 const source=['linear-adapter.ts','integrations.ts','index.ts'].map(file=>fs.readFileSync('supabase/functions/order-requests/'+file,'utf8').replace(/^import .*\n/gm,'').replace(/^export /gm,'')).join('\n');
 const context={structuredClone,createClient:()=>db,EdgeRuntime:{waitUntil:p=>tasks.push(p)},Deno:{env:{get:k=>env[k]},serve:fn=>{handler=fn;}},TextEncoder,TextDecoder,Uint8Array,Headers,Request,Response,URL,crypto:webcrypto,fetch:fakeFetch,AbortSignal,atob,btoa,generateOrderPdf:async()=>new TextEncoder().encode("%PDF-test"),console};
 vm.runInNewContext(stripTypeScriptTypes(source),context);
 return {raw:handler,rows,issues,events,jobs,flush:async()=>{await Promise.all(tasks);},call:async(body,bearer='staff',extraHeaders={})=>{
  const res=await handler(new Request('https://example.supabase.co/functions/v1/order-requests',{method:'POST',headers:{authorization:'Bearer '+bearer,origin:env.ORDER_APP_URL,...extraHeaders},body:JSON.stringify(body)}));
  return {status:res.status,data:await res.json()};
 }};
}
const payload={action:'create',id,company_name:'Acme',contact_name:'Dana',contact_email:'dana@acme.example',barcode_type:'linear',quote_name:'quote.pdf',quote_data:Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),salesforce_url:'https://example.salesforce.com/private'};
test('staff boundary rejects unauthenticated, unconfirmed and lookalike identities',async()=>{
 for(const [options,bearer] of [[{},'anon'],[{email:'graham.cooper@toolhound.com.evil.example'},'staff'],[{unconfirmed:true},'staff']]) {
  const r=runtime(options);const result=await r.call(payload,bearer);assert.equal(result.status,400);assert.equal(r.rows.size,0);assert.equal(r.events.length,0);
 }
});
test('quote is required but failed external upload does not block customer link',async()=>{
 const r=runtime({failUpload:true});
 assert.equal((await r.call({...payload,quote_data:''})).status,400); assert.equal(r.rows.size,0);
 const result=await r.call(payload);assert.equal(result.status,200);assert.ok(result.data.customer_url);await r.flush();
 assert.equal(r.rows.get(id).request_state,'ready');assert.equal(r.issues.size,0);assert.equal(r.jobs.get(id).status,'pending');
 const listed=await r.call({action:'list'});assert.equal(listed.data.requests[0].sync_pending,true);assert.equal(listed.data.requests[0].quote_name,'quote.pdf');assert.equal(listed.data.requests[0].quote_data,undefined);
 const params=new URLSearchParams(new URL(result.data.customer_url).hash.slice(1));assert.equal((await r.call({action:'load',id,token:params.get('token')},'anon')).status,200);
});
test('uncertain external creation keeps link usable and reconciles the same issue on retry',async()=>{
 const r=runtime({loseCreate:true});
 assert.equal((await r.call(payload)).status,200);await r.flush();assert.equal(r.issues.size,1);
 assert.equal((await r.call({action:'sync',id})).status,200);assert.equal(r.jobs.get(id).status,'succeeded');
 const result=await r.call({...payload,company_name:'Edited after uncertainty'});assert.equal(result.status,200);
 assert.equal(result.data.company_name,'Acme');assert.match(result.data.customer_url,/#request=.*&token=[a-f0-9]{64}$/);
 assert.equal(r.issues.size,1);assert.equal(r.rows.size,1);
 const params=new URLSearchParams(new URL(result.data.customer_url).hash.slice(1));
 const loaded=await r.call({action:'load',id,token:params.get('token')},'anon');
 assert.equal(loaded.status,200);assert.equal(loaded.data.prefill.companyName,'Acme');
 for(const secret of ['salesforce','quote_data','linear_issue','token_hash','private']) assert.ok(!JSON.stringify(loaded.data).includes(secret));
 assert.equal((await r.call({action:'load',id,token:'b'.repeat(64)},'anon')).status,400);
});
test('shadow creates a usable test link with no Linear API calls',async()=>{
 const r=runtime({mode:'shadow'});const result=await r.call(payload);assert.equal(result.status,200);
 assert.equal(result.data.mode,'shadow');assert.equal(r.events.length,0);assert.equal(r.issues.size,0);
});

test('quote PDF is staff-only and returns only the saved document fields',async()=>{
 const r=runtime({mode:'shadow'}); await r.call(payload);
 const unauth=await r.call({action:'quote',id},'anon');assert.equal(unauth.status,400);
 const result=await r.call({action:'quote',id});assert.equal(result.status,200);
 assert.equal(result.data.quote_data,payload.quote_data);assert.equal(result.data.quote_name,'quote.pdf');
 assert.deepEqual(Object.keys(result.data).sort(),['quote_data','quote_name']);
});

test('live creation applies configured template without overriding its assignment, labels or priority',async()=>{
 const r=runtime({templateId:'another-template'});const result=await r.call(payload);
 assert.equal(result.status,200);await r.flush();assert.equal(r.issues.size,1);
});

test('disabled integrations do not prevent request creation or a usable link',async()=>{
 const r=runtime({disabled:true});const result=await r.call(payload);await r.flush();
 assert.equal(result.status,200);assert.ok(result.data.customer_url);assert.equal(r.events.length,0);assert.equal(result.data.sync_pending,false);
});

test('order PDF requires staff and returns the exact attached artifact or shared-renderer fallback',async()=>{
 const orderId='10000000-0000-4000-8000-000000000001';
 const r=runtime({orders:[[orderId,{id:orderId,order_ref:'THL-TEST',order_request_id:id}]]});
 await r.call(payload);await r.flush();
 r.rows.get(id).external_metadata.vendor_pdf_url='https://uploads.linear.app/vendor';
 assert.equal((await r.call({action:'order_pdf',id:orderId,audience:'vendor'},'anon')).status,400);
 const attached=await r.call({action:'order_pdf',id:orderId,audience:'vendor'});
 assert.equal(Buffer.from(attached.data.pdf_data,'base64').toString(),'%PDF-exact-uploaded-bytes');
 const fallback=await r.call({action:'order_pdf',id:orderId,audience:'record'});
 assert.equal(Buffer.from(fallback.data.pdf_data,'base64').toString(),'%PDF-test');
 assert.equal((await r.call({action:'order_pdf',id:orderId,audience:'invalid'})).status,400);
});

test('every staff action uses database authorization and fails closed',async()=>{
 for(const options of [{email:'other@toolhound.com'},{email:'staff@beaconsoftware.com',denied:true},{authRpcError:{message:'Unavailable'}}]) {
  const r=runtime(options);
  for(const action of ['create','list','quote','order_pdf','recover','regenerate','revoke','mark_sent','sync']) {
   const res=await r.call({...payload,action}); assert.equal(res.status,400); assert.equal(r.events.length,0);
  }
 }
 const r=runtime({email:'staff@beaconsoftware.com',mode:'shadow'});
 assert.equal((await r.call(payload)).status,200);
});
test('oversized streaming bodies, declared sizes, and non-object JSON are rejected',async()=>{
 const r=runtime({mode:'shadow'});
 for(const body of [null,[],true]) assert.equal((await r.call(body)).status,400);
 assert.equal((await r.call({...payload,quote_data:'a'.repeat(14_500_001)})).status,400);
 assert.equal((await r.call(payload,'staff',{'content-length':'14500001'})).status,400);
 assert.equal(r.rows.size,0);assert.equal(r.events.length,0);
});

test('explicit local origins select the saved customer link destination',async()=>{
 const r=runtime({mode:'shadow',origins:'http://127.0.0.1:4175,http://localhost:4175'});
 const result=await r.call(payload,'staff',{origin:'http://127.0.0.1:4175'});
 assert.equal(result.status,200);assert.ok(result.data.customer_url.startsWith('http://127.0.0.1:4175/'));
 assert.equal(r.rows.get(id).app_origin,'http://127.0.0.1:4175');
 const recovered=await r.call({action:'recover',id});
 assert.equal(recovered.data.customer_url,result.data.customer_url);
 const regenerated=await r.call({action:'regenerate',id,token_version:1});
 assert.ok(regenerated.data.customer_url.startsWith('http://127.0.0.1:4175/'));
 assert.notEqual(regenerated.data.customer_url,result.data.customer_url);
 for(const origin of ['https://orders.example','http://127.0.0.1:4175','http://localhost:4175']) {
  const res=await r.raw(new Request('https://example.supabase.co',{method:'OPTIONS',headers:{origin}}));
  assert.equal(res.status,200);assert.equal(res.headers.get('access-control-allow-origin'),origin);
 }
 for(const origin of ['https://evil.example','null','http://localhost:9999','https://orders.example.evil.example']) {
  const res=await r.raw(new Request('https://example.supabase.co',{method:'OPTIONS',headers:{origin}}));
  assert.equal(res.status,403);assert.equal(res.headers.get('access-control-allow-origin'),null);
 }
});

test('missing Origin uses canonical URL; legacy requests ignore the recovering browser origin',async()=>{
 const r=runtime({mode:'shadow',origins:'http://localhost:4175'});
 const response=await r.raw(new Request('https://example.supabase.co',{method:'POST',headers:{authorization:'Bearer staff'},body:JSON.stringify({...payload,app_origin:'https://evil.example'})}));
 const created=await response.json();
 assert.match(created.customer_url,/^https:\/\/orders.example\//);
 assert.equal(r.rows.get(id).app_origin,'https://orders.example');
 delete r.rows.get(id).app_origin;
 const recovered=await r.call({action:'recover',id},'staff',{origin:'http://localhost:4175'});
 assert.match(recovered.data.customer_url,/^https:\/\/orders.example\//);
});
