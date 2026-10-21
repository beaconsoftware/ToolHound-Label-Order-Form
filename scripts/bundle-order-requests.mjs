import { build } from 'esbuild';
await build({ entryPoints: ['supabase/functions/order-requests/index.ts'], outfile: process.argv[2] || 'supabase/functions/order-requests/bundled.js', bundle: true, platform: 'neutral', format: 'esm', external: ['npm:*'], loader: { '.png': 'dataurl' } });
