const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');
function runtime(error=null) {
 const objects=new Map();let writes=0;
 const db={storage:{from:bucket=>{assert.equal(bucket,'order-artwork');return {
  upload:async(path,bytes,options)=>{writes++;assert.equal(options.upsert,false);if(error)return {error};if(objects.has(path))return {error:{statusCode:'409'}};objects.set(path,new Blob([bytes],{type:options.contentType}));return {};},
  download:async path=>({data:objects.get(path),error:!objects.has(path)})
 };}}};
 const context={Uint8Array,crypto:webcrypto,atob,btoa};
 vm.createContext(context);vm.runInContext(stripTypeScriptTypes(fs.readFileSync('supabase/functions/order-requests/artwork-storage.ts','utf8').replace(/^export /gm,'')),context);
 return {...context,db,objects,writes:()=>writes};
}
test('private storage preserves original bytes, MIME type, and immutable retry paths',async()=>{
 const r=runtime();const bytes=fs.readFileSync('public/toolhound-logo.png');const data='data:image/png;base64,'+bytes.toString('base64');
 const path=await r.storeArtwork(r.db,'request',data);
 assert.equal(await r.storeArtwork(r.db,'request',data),path);assert.equal(r.objects.size,1);
 const hydrated=await r.hydrateArtwork(r.db,{logo_storage_path:path,logo_file_data:null});assert.equal(hydrated.logo_file_data,data);
 assert.notEqual(await r.storeArtwork(r.db,'another-request',data),path);
 const legacy={logo_file_data:data};assert.equal(await r.hydrateArtwork(r.db,legacy),legacy);
 await assert.rejects(()=>r.hydrateArtwork(r.db,{logo_storage_path:'missing'}),/retrieved/);
});
test('invalid and oversize artwork cannot reach storage; storage errors fail the submission',async()=>{
 const r=runtime();
 for(const value of ['https://evil.example/a.png','data:text/html;base64,YQ==','data:image/png;base64,!', 'data:image/png;base64,'+Buffer.alloc(4*1024*1024+1).toString('base64')]) await assert.rejects(()=>r.storeArtwork(r.db,'request',value));
 assert.equal(r.writes(),0);
 const failed=runtime({statusCode:500});await assert.rejects(()=>failed.storeArtwork(failed.db,'request','data:image/png;base64,YQ=='),/could not be saved/);
});
