(async function () {
  'use strict';
  var status = document.getElementById('pdf-status');
  try {
    var id = new URLSearchParams(location.search).get('order');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Invalid order link. Open the PDF from the label orders table.');
    var cfg = window.TOOLHOUND_CONFIG || {};
    var client = window.__TOOLHOUND_CLIENT__ || window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    var session = await client.auth.getSession();
    if (!session.data.session) throw new Error('Sign in to admin in this browser, then reload this order PDF.');
    var result = await client.functions.invoke('order-requests', { body: { action: 'order_pdf', id: id, audience: new URLSearchParams(location.search).get('audience') || 'vendor' } });
    if (result.error) {
      var detail;
      try { detail = await result.error.context.json(); } catch (_) {}
      throw new Error((detail && detail.error) || 'Could not load the order PDF. Please retry from admin.');
    }
    if (result.data.error) throw new Error(result.data.error);
    var bytes = Uint8Array.from(atob(result.data.pdf_data), function (c) { return c.charCodeAt(0); });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The saved order PDF is not a valid PDF.');
    document.title = result.data.pdf_name;
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    // A top-level PDF uses the browser's native viewer, including in-app browsers.
    location.replace(url);

  } catch (err) { status.textContent = err.message || 'Could not open the order PDF.'; }
})();
