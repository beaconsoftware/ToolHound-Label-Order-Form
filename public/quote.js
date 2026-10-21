(async function () {
  'use strict';
  var status = document.getElementById('quote-status');
  try {
    var id = new URLSearchParams(location.search).get('request');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Invalid quote link. Open the quote from the request table.');
    var cfg = window.TOOLHOUND_CONFIG || {};
    var client = window.__TOOLHOUND_CLIENT__ || window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    var session = await client.auth.getSession();
    if (!session.data.session) throw new Error('Sign in to admin in this browser, then reload this quote.');
    var result = await client.functions.invoke('order-requests', { body: { action: 'quote', id: id } });
    if (result.error) {
      var detail;
      try { detail = await result.error.context.json(); } catch (_) {}
      throw new Error((detail && detail.error) || 'Could not load the quote. Please retry from admin.');
    }
    if (result.data.error) throw new Error(result.data.error);
    var bytes = Uint8Array.from(atob(result.data.quote_data), function (c) { return c.charCodeAt(0); });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The saved quote is not a valid PDF.');
    document.title = result.data.quote_name;
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    // A top-level PDF uses the browser's native viewer, including in-app browsers.
    location.replace(url);

  } catch (err) { status.textContent = err.message || 'Could not open the quote.'; }
})();
