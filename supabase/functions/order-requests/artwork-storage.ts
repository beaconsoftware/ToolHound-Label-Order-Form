// Original artwork stays private. Only the token-validated submission handler
// writes objects; staff and the integration worker can read saved order files.
export const ARTWORK_BUCKET = 'order-artwork';
export async function storeArtwork(db: any, requestId: string, dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|jpg|svg\+xml)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('Upload a valid PNG, JPEG, SVG or PDF artwork file.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)); }
  catch { throw new Error('Invalid artwork encoding.'); }
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Artwork must be smaller than 4 MB.');
  const contentType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const extension = ({'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg','application/pdf':'pdf'} as Record<string,string>)[contentType];
  // Content-addressed immutable paths make retries/concurrent submissions safe.
  const path = `${requestId}/${digest}.${extension}`;
  const { error } = await db.storage.from(ARTWORK_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error && String(error.statusCode) !== '409') throw new Error('Artwork could not be saved. Please retry the submission.');
  return path;
}
export async function hydrateArtwork(db: any, order: any) {
  if (!order?.logo_storage_path) return order;
  const { data, error } = await db.storage.from(ARTWORK_BUCKET).download(order.logo_storage_path);
  if (error || !data) throw new Error('The saved artwork could not be retrieved. Please retry.');
  const bytes = new Uint8Array(await data.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ...order, logo_file_data: `data:${data.type};base64,${btoa(binary)}` };
}
