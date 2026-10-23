const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');

for (const mime of [null, 'custom_text', 'image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf']) test('submission preserves PDFs and artwork on retry: '+mime,async()=>{
 const source=fs.readFileSync('supabase/functions/order-requests/linear-adapter.ts','utf8').replace(/^import .*\n/gm,'').replace(/^export /gm,'');
 const metadata={quote_asset_url:'https://uploads/quote'};
 const request={id:'request',quote_version:1};
 const order={customer_po:'PO-12345',order_ref:'THL-SAVED-REF',submitted_at:'2026-10-20',company_name:'Saved customer', ...(mime === 'custom_text' ? {logo_choice:'custom_text',text_lines:['123456789012345678','Line two','Line three']} : mime ? {logo_choice:'custom_logo',logo_file_name:'customer-artwork',logo_file_data:'data:'+mime+';base64,'+Buffer.from('original file bytes').toString('base64')} : {})};
 let uploads=0,failed=false,body,rendered=[];
 let description='### Customer Name\n\nEdited by Graham\n\n### Label Order Form\n\nAwaiting customer submission\n\n### MetalCraft Quote\n\nKeep this quote\n\n### Customer logo\n\nNot provided\n\n### Other\n\nKeep these notes';
 const db={from:table=>{const q={select:()=>q,eq:()=>q,single:async()=>({data:order}),update:v=>{Object.assign(metadata,v.external_metadata);return q;},then:resolve=>Promise.resolve({data:null}).then(resolve)};return q;}};
 const fetch=async(url,init)=>{
  if(url==='https://upload') { if(uploads===3){assert.equal(init.headers.get('Content-Type'),mime);assert.equal(Buffer.from(init.body).toString(),'original file bytes');} return new Response('',{status:200}); }
  const {query,variables}=JSON.parse(init.body);
  if(query.includes('fileUpload'))return Response.json({data:{fileUpload:{success:true,uploadFile:{uploadUrl:'https://upload',assetUrl:'https://asset/'+(++uploads),headers:[]}}}});
  if(query.includes('issue(id:'))return Response.json({data:{issue:{id:'ticket',description}}});
  if(query.includes('issueUpdate')){description=variables.input.description;return Response.json({data:{issueUpdate:{success:true}}});}
  if(query.includes('comments('))return Response.json({data:{comments:{nodes:[{id:'request',issue:{id:'ticket'}}]}}});
  assert.match(query,/commentUpdate/);body=variables.input.body;
  if(!failed){failed=true;throw Error('lost response');}
  return Response.json({data:{commentUpdate:{success:true}}});
 };
 const context={fetch,Response,Headers,AbortSignal,Uint8Array,atob,generateOrderPdf:async(row,a)=>{assert.equal(row,order);rendered.push(a);return new Uint8Array([37,80,68,70]);}};
 vm.createContext(context);vm.runInContext(stripTypeScriptTypes(source),context);
 const adapter=context.createLinearAdapter(db,()=> 'https://orders',r=>r.data);
 const external={external_id:'ticket',metadata};
 await assert.rejects(adapter['order.submitted'](request,external),/lost response/);
 await adapter['order.submitted'](request,external);
 assert.match(description,/Edited by Graham/);assert.match(description,/Keep this quote/);
 assert.ok(!description.includes('Awaiting customer submission'));
 assert.equal(description.split('[Signed customer order PDF]').length,2);
 assert.match(description,/Keep these notes/);
 if(mime === 'custom_text') {assert.equal(description.split('### Custom text').length,2);assert.match(description,/    123456789012345678\n    Line two\n    Line three/);}
 else if(mime) {assert.equal(description.split('[Customer artwork]').length, ['image/png','image/jpeg'].includes(mime) ? 3 : 2);assert.ok(metadata.artwork_asset_url);}
 else {assert.ok(!metadata.artwork_asset_url);assert.match(description,/### Customer logo\n\nNot provided/);}
 assert.equal(uploads,mime && mime !== 'custom_text' ? 3 : 2);assert.deepEqual(rendered,['vendor','record']);
 assert.match(body,/Customer PO #: PO-12345/);assert.match(description,/Customer PO #: PO-12345/);assert.match(body,/THL-SAVED-REF/);assert.match(body,/Vendor order PDF/);assert.match(body,/Signed customer order PDF/);
});

test('shared document renders vendor and signed PDFs with embedded signature',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-pdf-'));
 const output=path.join(dir,'renderer.cjs');
 try {
  await require('esbuild').build({entryPoints:['supabase/functions/order-requests/order-pdf.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',loader:{'.png':'dataurl'},plugins:[{name:'npm',setup(b){b.onResolve({filter:/^npm:/},a=>({path:require.resolve(a.path.replace(/^npm:/,'').replace(/@\d[^/]*/,''))}))}}]});
  const {generateOrderPdf}=require(output);
  const signature='data:image/png;base64,'+fs.readFileSync('public/toolhound-logo.png').toString('base64');
  const row={customer_po:'PO-12345',attention_name:'Receiving department',address:'1 Main Street',city:'Toronto',state_province:'ON',postal_code:'M1M 1M1',country:'Canada',order_ref:'1001',company_name:'Acme Montréal',text_lines:['Equipment'],instructions:'Ship rolls of 500. '.repeat(100),signature_data:signature,authorized_name:'Jane Smith',approval_date:'2026-10-20'};
  const vendor=await generateOrderPdf(row,'vendor'), signed=await generateOrderPdf(row,'record');
  for(const bytes of [vendor,signed]){assert.equal(Buffer.from(bytes).subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>10000);}
  assert.ok(signed.length>vendor.length);
  if(process.env.PDF_REVIEW_DIR){fs.writeFileSync(path.join(process.env.PDF_REVIEW_DIR,'vendor.pdf'),vendor);fs.writeFileSync(path.join(process.env.PDF_REVIEW_DIR,'signed.pdf'),signed);}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
