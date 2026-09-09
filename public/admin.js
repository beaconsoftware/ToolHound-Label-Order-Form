/**
 * ToolHound internal label orders dashboard.
 *
 * Shows every order the public form has produced, its workflow status, and how
 * long it has been outstanding. Staff move an order through received -> PO sent
 * -> production confirmed -> shipped; the stage timestamps are written by a
 * database trigger, not by this page.
 *
 * Access: Supabase Auth — Google for Beacon accounts, or an emailed sign-in
 * link — then a Beacon email domain check. The check below decides what
 * renders and nothing more. The actual boundary is the RLS policy in
 * supabase/migrations/0006_restrict_staff_reads.sql, which runs on every
 * request whether it came from this page or from curl. Treating the JavaScript
 * as the boundary is how these dashboards leak.
 *
 * That split is why sign-ups being open is not a hole: someone outside Beacon
 * can obtain a session and still read nothing, because the policy checks the
 * email claim on the JWT rather than trusting that an account exists.
 *
 * No build step: this file is loaded directly by admin.html.
 */
(function () {
  'use strict';

  var CONFIG = window.TOOLHOUND_CONFIG || {};

  /**
   * Who may open the dashboard.
   *
   * This list only decides what the page renders. Access is granted by
   * public.is_label_order_staff() in migration 0006, so changing the allowlist
   * means changing it there too — and that is the one that matters.
   */
  var ALLOWED_DOMAINS = ['beaconsoftware.com'];


  var STATUSES = [
    { value: 'received', label: 'Received' },
    { value: 'po_sent', label: 'PO sent' },
    { value: 'production_confirmed', label: 'Production confirmed' },
    { value: 'shipped', label: 'Shipped' },
    { value: 'cancelled', label: 'Cancelled' }
  ];

  var STATUS_LABELS = STATUSES.reduce(function (acc, s) {
    acc[s.value] = s.label;
    return acc;
  }, {});

  var LOGO_CHOICE_LABELS = {
    custom_logo: 'Custom Logo',
    custom_text: 'Custom Text',
    toolhound_logo: 'ToolHound Logo',
    serial_only: 'Serial number only'
  };

  var FILTERS = [
    { key: 'open', label: 'Open' },
    { key: 'received', label: 'Received' },
    { key: 'po_sent', label: 'PO sent' },
    { key: 'production_confirmed', label: 'In production' },
    { key: 'shipped', label: 'Shipped' },
    { key: 'all', label: 'All' }
  ];

  /**
   * An open order older than this many days is called out in red. Not a
   * business rule, just the point at which "how long has this been sitting"
   * stops being obvious from the date alone.
   */
  var STALE_DAYS = 7;

  // Columns the dashboard reads. logo_file_data is deliberately excluded from
  // the list view: it is up to ~6MB of base64 per row, so pulling it for every
  // order would make the table crawl. It is fetched per order on download.
  //
  // signature_data is included, and is the one customer-supplied image this
  // page does render. That is safe specifically because the database constrains
  // it to `data:image/png;base64,` under 2MB (migration 0003): a PNG cannot
  // carry script, where the SVG the artwork column accepts can.
  var LIST_COLUMNS = [
    // quote_number is not optional here. It is the reference the label order
    // document tells Metalcraft to quote back on the proof, acknowledgement,
    // packing slip and invoice, and the document falls back to the internal
    // THL- ref when it is missing. Leaving it out of this list printed that
    // fallback on real orders that had a quote number all along.
    'id', 'order_ref', 'quote_number', 'submitted_at', 'status',
    'signature_data',
    'po_sent_at', 'production_confirmed_at', 'shipped_at', 'cancelled_at',
    'updated_at', 'internal_notes',
    'company_name', 'contact_name', 'contact_email',
    'address', 'city', 'state_province', 'postal_code', 'country',
    'logo_choice', 'logo_file_name', 'text_lines', 'full_color',
    'quantity', 'start_seq', 'seq_start', 'instructions',
    // adhesive is on the document Metalcraft works from, so leaving it out of
    // this list would print a dash on every order that has one -- the same way
    // quote_number printed the internal ref.
    'label_type', 'adhesive', 'label_width_in', 'label_height_in',
    'ship_to_phone', 'attention_name', 'customer_po',
    'authorized_name', 'approval_date'
  ].join(',');

  var state = {
    phase: 'loading',   // loading | config_error | signed_out | denied | ready
    session: null,
    email: '',
    orders: [],
    filter: 'open',
    query: '',
    drawerId: null,
    recordId: null,
    recordAudience: 'vendor',
    confirmDeleteId: null,
    loadError: '',
    rowErrors: {},      // order id -> message
    busyRows: {}        // order id -> true while a write is in flight
  };

  var client = null;
  var authError = '';

  // ---------------------------------------------------------------------------
  // DOM helpers (same shape as the order form's, kept local on purpose so the
  // two pages can be changed independently)
  // ---------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    if (children === undefined || children === null) return node;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function root() { return document.getElementById('root'); }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function daysSince(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function isOpen(order) {
    return order.status !== 'shipped' && order.status !== 'cancelled';
  }

  /**
   * For an open order this is time outstanding, which is the number staff
   * actually want. For a closed one it is how long the order took, which stops
   * counting — a shipped order is not "180 days outstanding".
   */
  function ageText(order) {
    if (!isOpen(order)) {
      var closedAt = order.status === 'shipped' ? order.shipped_at : order.cancelled_at;
      if (!closedAt) return order.status === 'shipped' ? 'shipped' : 'cancelled';
      var span = Math.floor(
        (new Date(closedAt).getTime() - new Date(order.submitted_at).getTime()) / 86400000);
      if (isNaN(span) || span < 0) return '';
      var verb = order.status === 'shipped' ? 'shipped in' : 'cancelled after';
      return verb + ' ' + span + (span === 1 ? ' day' : ' days');
    }
    var days = daysSince(order.submitted_at);
    if (days === null) return '';
    if (days <= 0) return 'today';
    return days + (days === 1 ? ' day' : ' days') + ' outstanding';
  }

  function labelSpec(order) {
    var choice = LOGO_CHOICE_LABELS[order.logo_choice] || order.logo_choice || '—';
    if (order.logo_choice === 'custom_text') {
      var lines = (order.text_lines || []).filter(function (l) { return l && String(l).trim(); });
      return lines.length ? choice + ': ' + lines.join(' / ') : choice;
    }
    if (order.logo_choice === 'custom_logo' && order.logo_file_name) {
      return choice + ' (' + order.logo_file_name + ')';
    }
    return choice;
  }

  /**
   * The label number is the string the customer typed, and the end of the run
   * is derived by incrementing its trailing digits at the same width — so
   * TSG-0001 over 500 labels reads TSG-0500, not TSG-500. Falls back to the
   * pre-0009 numeric column for older orders.
   */
  function sequenceRange(order) {
    var start = String(order.seq_start || '').trim();
    if (!start && order.start_seq != null) start = String(order.start_seq);
    var qty = Number(order.quantity);
    if (!start || !isFinite(qty) || qty < 1) return '—';

    var m = /(\d+)$/.exec(start);
    if (!m) return start + ' – —';
    var digits = m[1];
    var head = start.slice(0, start.length - digits.length);
    var end = String(parseInt(digits, 10) + qty - 1);
    while (end.length < digits.length) end = '0' + end;
    return start + ' – ' + head + end;
  }

  /**
   * The stock's own wording for the size wins, so the drawer says 0.625" Round
   * rather than restating a circular die as a square. Falling back to the raw
   * numbers covers legacy rows, which carry no type to look the size up under.
   * Three decimals, trimmed: at two, 0.625" reads as 0.63" and the drawer
   * disagrees with the die the labels are actually cut on.
   */
  function labelSize(order) {
    var w = Number(order.label_width_in);
    var h = Number(order.label_height_in);
    if (!isFinite(w) || !isFinite(h) || !w || !h) return '—';
    var named = sizeLabel(order.label_type, w, h);
    if (named) return named;
    return inches(w) + '" x ' + inches(h) + '"';
  }

  function sizeLabel(labelType, w, h) {
    var types = (window.TOOLHOUND_CONFIG || {}).labelTypes || [];
    for (var i = 0; i < types.length; i++) {
      if (types[i].value !== labelType) continue;
      var sizes = types[i].sizes || [];
      for (var j = 0; j < sizes.length; j++) {
        if (Number(sizes[j].w) === w && Number(sizes[j].h) === h) {
          return sizes[j].label;
        }
      }
    }
    return '';
  }

  function inches(n) {
    return n.toFixed(3).replace(/(\.\d\d)0$/, '$1');
  }

  function labelTypeText(order) {
    var types = (window.TOOLHOUND_CONFIG || {}).labelTypes || [];
    for (var i = 0; i < types.length; i++) {
      if (types[i].value === order.label_type) return types[i].label;
    }
    // Pre-field rows carry no type; all of them are poly pro.
    return order.label_type
      || (window.TOOLHOUND_CONFIG || {}).labelStock || '—';
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Tests inject a stub through `window.__TOOLHOUND_CLERK__`, so the gate and
   * the table can be exercised without Supabase credentials or network access.
   */
  /**
   * The Supabase client handles both auth and data, so the session token is
   * attached to queries automatically and there is no token plumbing to get
   * wrong. Tests inject a stub through `window.__TOOLHOUND_CLIENT__`.
   */
  function getClient() {
    if (window.__TOOLHOUND_CLIENT__) return window.__TOOLHOUND_CLIENT__;
    if (!window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) return null;
    if (!getClient._client) {
      getClient._client = window.supabase.createClient(
        CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    }
    return getClient._client;
  }

  function signedInEmail() {
    return String((state.session && state.session.user && state.session.user.email) || '')
      .toLowerCase();
  }

  function domainAllowed(email) {
    var at = String(email || '').lastIndexOf('@');
    if (at < 1) return false;
    var domain = email.slice(at + 1);
    // Exact domain match, not a suffix test: `beaconsoftware.com.attacker.example`
    // and `notbeaconsoftware.com` must both fail, and so must a subdomain.
    return ALLOWED_DOMAINS.some(function (d) { return domain === d; });
  }

  function signInWithGoogle() {
    if (!client) return;
    client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/admin.html',
        // Points Google's own account picker at the right domain. A
        // convenience, not a restriction — it is trivially removable from the
        // URL, which is why the domain is checked again in the policy.
        queryParams: { hd: ALLOWED_DOMAINS[0] }
      }
    });
  }

  function sendMagicLink(email, button, statusEl) {
    if (!client) return;
    if (!email) {
      if (statusEl) statusEl.textContent = 'Enter your email address first.';
      return;
    }
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    Promise.resolve(client.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.origin + '/admin.html' }
    })).then(function (res) {
      if (res && res.error) throw res.error;
      if (statusEl) {
        statusEl.textContent = 'Check ' + email + ' for a sign-in link.';
      }
    }).catch(function (err) {
      console.error('Magic link request failed', err);
      if (statusEl) {
        statusEl.textContent = 'Could not send the link: '
          + (err && err.message ? err.message : 'unknown error');
      }
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = 'Email me a sign-in link'; }
    });
  }

  function signOut() {
    if (!client) return;
    Promise.resolve(client.auth.signOut()).then(function () {
      state.session = null;
      applySession();
    });
  }

  /**
   * A sign-in rejected after the provider handed off — the auth.users trigger
   * from migration 0005 refusing an off-domain Google account, say — comes back
   * as `#error=...` on the redirect URL rather than a failed promise. Surface
   * it and drop it from the URL so a reload does not replay it.
   */
  function authErrorFromUrl() {
    var hash = window.location.hash || '';
    if (hash.indexOf('error=') === -1) return '';
    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var desc = params.get('error_description') || params.get('error') || '';
    history.replaceState(null, '', window.location.pathname);
    return desc ? decodeURIComponent(desc.replace(/\+/g, ' ')) : 'Sign in failed.';
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /**
   * The columns the Ramp PO script reads, in the order it presents them.
   * Enumerated rather than spreading the whole row: logo_file_data alone is
   * megabytes of base64, and a file handed to somebody else should carry what
   * the job needs and nothing more.
   */
  var PO_INPUT_FIELDS = [
    'order_ref', 'quote_number', 'submitted_at', 'status',
    'company_name', 'contact_name', 'contact_email',
    'address', 'city', 'state_province', 'postal_code', 'country',
    'attention_name', 'ship_to_phone', 'customer_po',
    'logo_choice', 'logo_file_name', 'text_lines', 'full_color',
    'label_type', 'adhesive', 'label_width_in', 'label_height_in',
    'quantity', 'seq_start', 'start_seq', 'instructions'
  ];

  /**
   * Hand the order over as a file the label-order-ramp-po skill can read
   * directly, so building a PO does not need a database query at all.
   *
   * The rows are wrapped in an object with a note rather than emitted as a
   * bare array: this file gets downloaded, sat on, and opened later by someone
   * who has forgotten what it was, so it should say so itself. The script
   * accepts either shape.
   */
  function downloadPoInputs(orders, filename) {
    var rows = orders.map(function (o) {
      var out = {};
      PO_INPUT_FIELDS.forEach(function (k) {
        if (o[k] !== undefined) out[k] = o[k];
      });
      return out;
    });

    var payload = {
      skill: 'label-order-ramp-po',
      purpose: 'Inputs for the Metalcraft vendor PO. Give this file to Claude '
        + 'and ask it to build the Ramp PO.',
      note: 'Label POs go to Metalcraft at 0.00 per unit. They do not invoice '
        + 'until they have the PO, so the price is not known when it is raised '
        + '— the quantity and the line description are what the PO communicates.',
      generated_at: new Date().toISOString(),
      source: window.location.origin + '/admin',
      orders: rows
    };

    var link = el('a', {
      href: 'data:application/json;charset=utf-8,'
        + encodeURIComponent(JSON.stringify(payload, null, 2)),
      download: filename
    });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function getDb() { return client || getClient(); }

  /**
   * Delete an order outright.
   *
   * This removes a signed customer authorization and there is no undo -- no
   * archive table, no soft-delete flag. The two-step confirmation in the drawer
   * is the whole safety net, which is why it names the order and says the word
   * "permanently" rather than just asking "are you sure?".
   *
   * Migration 0010 grants DELETE to staff; before it is applied this fails with
   * a permission error, which is reported rather than swallowed.
   */
  function deleteOrder(order, button, statusEl) {
    var db = getDb();
    if (!db) return;
    if (button) { button.disabled = true; button.textContent = 'Deleting…'; }
    if (statusEl) statusEl.textContent = '';

    Promise.resolve(db.from('label_orders').delete().eq('id', order.id))
      .then(function (res) {
        if (res && res.error) throw res.error;
        state.orders = state.orders.filter(function (o) { return o.id !== order.id; });
        state.drawerId = null;
        state.recordId = null;
        state.confirmDeleteId = null;
        render();
      })
      .catch(function (err) {
        console.error('Delete failed', err);
        if (button) { button.disabled = false; button.textContent = 'Delete permanently'; }
        if (statusEl) {
          statusEl.textContent = 'Could not delete this order: '
            + (err && err.message ? err.message : 'unknown error')
            + '. If it mentions permissions, migration 0010 is not applied yet.';
        }
      });
  }

  function loadOrders() {
    var db = getDb();
    if (!db) {
      state.loadError = 'The order database is not reachable from this page.';
      render();
      return Promise.resolve();
    }
    return Promise.resolve(
      db.from('label_orders')
        .select(LIST_COLUMNS)
        .order('submitted_at', { ascending: false })
    ).then(function (res) {
      if (res && res.error) throw res.error;
      state.orders = (res && res.data) || [];
      state.loadError = '';
      render();
    }).catch(function (err) {
      console.error('Failed to load orders', err);
      state.loadError = 'Could not load orders: ' + (err && err.message ? err.message : 'unknown error')
        + '. If you are signed in with a ' + ALLOWED_DOMAINS[0] + ' account and still '
        + 'see nothing, migration 0007 may not be applied yet.';
      render();
    });
  }

  function setStatus(order, nextStatus, selectEl) {
    var db = getDb();
    if (!db) return;
    var previous = order.status;
    state.busyRows[order.id] = true;
    delete state.rowErrors[order.id];
    if (selectEl) selectEl.disabled = true;

    Promise.resolve(
      db.from('label_orders')
        .update({ status: nextStatus })
        .eq('id', order.id)
        .select(LIST_COLUMNS)
    ).then(function (res) {
      if (res && res.error) throw res.error;
      // Take the row back from the database rather than patching locally: the
      // stage timestamps are set by a trigger, so the returned row is the only
      // place the new po_sent_at / shipped_at values exist.
      var updated = res && res.data && res.data[0];
      if (updated) {
        state.orders = state.orders.map(function (o) {
          return o.id === updated.id ? updated : o;
        });
      } else {
        order.status = nextStatus;
      }
      delete state.busyRows[order.id];
      render();
    }).catch(function (err) {
      console.error('Status update failed', err);
      order.status = previous;
      delete state.busyRows[order.id];
      state.rowErrors[order.id] = 'Could not save the status change: '
        + (err && err.message ? err.message : 'unknown error');
      render();
    });
  }

  /**
   * Write one or more staff-editable fields on an order.
   *
   * Shared by internal notes and the adhesive rather than copied per field: a
   * second copy is a second place to forget to fold the returned row back into
   * state, which is how a saved value stops showing until a reload.
   */
  function saveOrderPatch(order, patch, button, statusEl, buttonLabel) {
    var db = getDb();
    if (!db) return;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    delete state.rowErrors[order.id];

    Promise.resolve(
      db.from('label_orders')
        .update(patch)
        .eq('id', order.id)
        .select(LIST_COLUMNS)
    ).then(function (res) {
      if (res && res.error) throw res.error;
      var updated = res && res.data && res.data[0];
      if (updated) {
        state.orders = state.orders.map(function (o) {
          return o.id === updated.id ? updated : o;
        });
      } else {
        Object.keys(patch).forEach(function (k) { order[k] = patch[k]; });
      }
      if (button) { button.disabled = false; button.textContent = buttonLabel; }
      if (statusEl) statusEl.textContent = 'Saved.';
    }).catch(function (err) {
      console.error('Order update failed', err);
      if (button) { button.disabled = false; button.textContent = buttonLabel; }
      if (statusEl) {
        statusEl.textContent = 'Could not save: '
          + (err && err.message ? err.message : 'unknown error');
      }
    });
  }

  /**
   * Artwork is fetched only when someone asks for it, and only ever handed over
   * as a download.
   *
   * It is never rendered inline, and that is not a stylistic choice: customers
   * upload SVG because vector art reproduces best at label size, and an SVG can
   * carry script. Putting one in an <img>, an <object>, or innerHTML on a page
   * that holds a live staff session is a stored XSS with the session sitting
   * right there. A download hands the file to the operating system instead.
   */
  function downloadArtwork(order, button, statusEl, label) {
    var db = getDb();
    if (!db) return;
    var restore = label || 'Download artwork';
    if (button) { button.disabled = true; button.textContent = '…'; }
    if (statusEl) statusEl.textContent = '';

    Promise.resolve(
      db.from('label_orders')
        .select('logo_file_name,logo_file_data')
        .eq('id', order.id)
        .limit(1)
    ).then(function (res) {
      if (res && res.error) throw res.error;
      var row = res && res.data && res.data[0];
      if (!row || !row.logo_file_data) {
        if (statusEl) statusEl.textContent = 'No artwork is attached to this order.';
        return;
      }
      var link = el('a', {
        href: row.logo_file_data,
        download: row.logo_file_name || (order.order_ref + '-artwork')
      });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }).catch(function (err) {
      console.error('Artwork download failed', err);
      if (statusEl) {
        statusEl.textContent = 'Could not fetch the artwork: '
          + (err && err.message ? err.message : 'unknown error');
      }
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = restore; }
    });
  }

  /**
   * Put the order on the clipboard in a form that survives a paste into
   * Outlook or Gmail: rich HTML, with a plain-text flavour alongside for a
   * plain-text composer.
   *
   * Two flavours in one clipboard write is the whole point. A single text/html
   * write pastes as literal tags in a plain-text composer; a single text/plain
   * write loses the layout everywhere. The async Clipboard API carries both.
   *
   * The fallback for browsers without ClipboardItem copies from a hidden
   * contenteditable, which is how this was done before that API and still
   * yields rich text.
   *
   * Artwork: fetched on demand, and inlined only when it is a raster. SVG is
   * never inlined -- the same reason downloadArtwork() exists, since an SVG
   * can carry script -- and a PDF cannot be an <img> at all, so those are
   * named in the email and attached by hand instead.
   */
  var INLINEABLE_ARTWORK = /^data:image\/(png|jpeg|jpg|gif);base64,/i;

  function writeRichClipboard(html, text) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      return navigator.clipboard.write([new window.ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      })]);
    }
    return new Promise(function (resolve, reject) {
      var host = el('div', {});
      host.setAttribute('contenteditable', 'true');
      host.style.cssText =
        'position:fixed;left:-9999px;top:0;white-space:pre-wrap;';
      host.innerHTML = html;
      document.body.appendChild(host);
      try {
        var range = document.createRange();
        range.selectNodeContents(host);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var ok = document.execCommand('copy');
        sel.removeAllRanges();
        ok ? resolve() : reject(new Error('Copy was refused by the browser'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(host);
      }
    });
  }

  function copyOrderForEmail(order, button, statusEl) {
    var mod = window.TOOLHOUND_ORDER_DOC;
    if (!mod || !mod.emailHtml) {
      if (statusEl) statusEl.textContent = 'order-doc.js did not load.';
      return;
    }
    var restore = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Copying…'; }
    if (statusEl) statusEl.textContent = '';

    fetchArtworkForEmail(order).then(function (artwork) {
      var o = mod.fromRow(order);
      var opts = {
        // Absolute, because a relative src means nothing once the HTML is in
        // somebody's mail client.
        logoUrl: new URL('toolhound-logo.png', document.baseURI).href,
        artwork: artwork
      };
      return writeRichClipboard(mod.emailHtml(o, opts), mod.emailText(o, opts))
        .then(function () {
          if (statusEl) {
            statusEl.textContent = 'Copied. Paste into your email.'
              + (artwork && artwork.name && !artwork.dataUrl
                ? ' Attach ' + artwork.name + ' — it cannot be pasted inline.'
                : '');
          }
        });
    }).catch(function (err) {
      console.error('Copy for email failed', err);
      if (statusEl) {
        statusEl.textContent = 'Could not copy: '
          + (err && err.message ? err.message : 'unknown error');
      }
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = restore; }
    });
  }

  /** Resolves to { name, dataUrl? }, or null when the order has no artwork. */
  function fetchArtworkForEmail(order) {
    if (order.logo_choice !== 'custom_logo') return Promise.resolve(null);
    var db = getDb();
    if (!db) return Promise.resolve({ name: order.logo_file_name });
    return Promise.resolve(
      db.from('label_orders')
        .select('logo_file_name,logo_file_data')
        .eq('id', order.id)
        .limit(1)
    ).then(function (res) {
      if (res && res.error) throw res.error;
      var row = (res && res.data && res.data[0]) || {};
      var name = row.logo_file_name || order.logo_file_name;
      if (!name) return null;
      if (row.logo_file_data && INLINEABLE_ARTWORK.test(row.logo_file_data)) {
        return { name: name, dataUrl: row.logo_file_data };
      }
      return { name: name };
    }).catch(function () {
      // The email is still worth having without the picture in it.
      return { name: order.logo_file_name };
    });
  }

  /**
   * Print the record that is currently open, once its images are in.
   *
   * Printing straight after render raced the signature and the logo: both are
   * images, and a print started before they decode comes out with gaps where
   * they should be.
   */
  function printOpenRecord() {
    var node = document.querySelector('.record-doc');
    if (!node) return;

    var fired = false;
    function go() {
      if (fired) return;
      fired = true;
      // Scoped to the record: the print stylesheet keys off this class so the
      // dashboard behind it does not come out of the printer too.
      document.body.classList.add('printing-record');
      var done = function () {
        document.body.classList.remove('printing-record');
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      window.print();
      // Safari fires afterprint unreliably; this is the belt to that brace.
      window.setTimeout(done, 1000);
    }

    var pending = Array.prototype.slice.call(node.querySelectorAll('img'))
      .filter(function (img) { return !img.complete; });
    if (!pending.length) { go(); return; }

    var left = pending.length;
    function oneDone() { if (--left <= 0) go(); }
    pending.forEach(function (img) {
      img.addEventListener('load', oneDone);
      img.addEventListener('error', oneDone);
    });
    // Never hang on artwork that will not load.
    window.setTimeout(go, 1500);
  }

  /** Open the authorization record, optionally going straight to print. */
  /**
   * `audience` decides which document opens: 'vendor' is the sheet that goes to
   * Metalcraft, 'record' is the signed customer authorisation kept internally.
   * The authorisation is never dropped from the database or from this page --
   * it just does not belong in front of the supplier.
   */
  function openRecord(order, andPrint, audience) {
    state.recordId = order.id;
    state.recordAudience = audience === 'record' ? 'record' : 'vendor';
    render();
    if (andPrint) printOpenRecord();
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  function visibleOrders() {
    var q = state.query.trim().toLowerCase();
    return state.orders.filter(function (o) {
      if (state.filter === 'open' && !isOpen(o)) return false;
      if (state.filter !== 'open' && state.filter !== 'all' && o.status !== state.filter) return false;
      if (!q) return true;
      return [o.order_ref, o.company_name, o.contact_name, o.contact_email]
        .some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
    }).sort(function (a, b) {
      // Open orders oldest first, because age is the thing that needs acting
      // on. Everything else newest first.
      var openView = state.filter === 'open';
      var at = new Date(a.submitted_at).getTime();
      var bt = new Date(b.submitted_at).getTime();
      return openView ? at - bt : bt - at;
    });
  }

  // ---------------------------------------------------------------------------
  // Gate screens
  // ---------------------------------------------------------------------------

  function renderGate(icon, heading, paragraphs, extra) {
    var box = el('div', { class: 'gate' }, [el('div', { class: 'gate-icon', text: icon })]);
    box.appendChild(el('h1', { text: heading }));
    (paragraphs || []).forEach(function (p) {
      box.appendChild(typeof p === 'string' ? el('p', { text: p }) : p);
    });
    if (extra) box.appendChild(extra);
    clear(root()).appendChild(box);
  }

  function renderConfigError() {
    renderGate('⚙️', 'Dashboard not available', [
      'The order system could not be reached, so sign-in cannot be initialised '
      + 'and no orders will be shown.',
      'Check the Supabase URL and publishable key in config.js. The customer '
      + 'order form is unaffected.'
    ]);
  }

  function renderSignedOut() {
    var box = el('div', { class: 'gate' }, [
      el('div', { class: 'gate-icon', text: '🔐' }),
      el('h1', { text: 'ToolHound Label Orders' }),
      el('p', { text: 'Sign in with your ' + ALLOWED_DOMAINS.join(' or ') + ' account.' })
    ]);

    if (authError) {
      box.appendChild(el('div', { class: 'form-error', role: 'alert', text: authError }));
    }

    box.appendChild(el('div', { class: 'signin-actions' }, [
      el('button', { class: 'primary', onclick: signInWithGoogle },
        'Continue with Google')
    ]));

    box.appendChild(el('div', { class: 'signin-divider', text: 'or' }));

    var emailInput = el('input', {
      type: 'email',
      placeholder: 'you@' + ALLOWED_DOMAINS[0],
      autocomplete: 'username',
      'aria-label': 'Work email'
    });
    var linkStatus = el('div', { class: 'hint', role: 'status' });
    var linkBtn = el('button', { class: 'ghost' }, 'Email me a sign-in link');
    linkBtn.addEventListener('click', function () {
      sendMagicLink(emailInput.value.trim().toLowerCase(), linkBtn, linkStatus);
    });
    emailInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        sendMagicLink(emailInput.value.trim().toLowerCase(), linkBtn, linkStatus);
      }
    });

    box.appendChild(el('div', { class: 'field' }, [emailInput]));
    box.appendChild(el('div', { class: 'signin-actions' }, [linkBtn]));
    box.appendChild(linkStatus);

    clear(root()).appendChild(box);
  }

  function renderDenied() {
    var email = state.email || 'an unknown address';
    var explain = el('p', {}, [
      'This dashboard is restricted to ',
      el('strong', { text: ALLOWED_DOMAINS.join(' or ') }),
      ' accounts. You are signed in as ',
      el('code', { text: email }),
      '.'
    ]);
    var actions = el('div', { class: 'gate-actions' }, [
      el('button', {
        class: 'primary',
        onclick: signOut
      }, 'Sign out')
    ]);
    renderGate('🔒', 'Access restricted', [explain], actions);
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  function renderUserSlot() {
    var slot = document.getElementById('userSlot');
    if (!slot) return;
    clear(slot);
    if (state.phase !== 'ready') return;
    slot.appendChild(el('span', { text: state.email }));
    slot.appendChild(el('button', { class: 'topbar-signout', onclick: signOut }, 'Sign out'));
  }

  function statsFor(orders) {
    var open = orders.filter(isOpen);
    var stale = open.filter(function (o) {
      var d = daysSince(o.submitted_at);
      return d !== null && d >= STALE_DAYS;
    });
    return [
      { n: open.length, l: 'Open', warn: false },
      {
        n: orders.filter(function (o) { return o.status === 'received'; }).length,
        l: 'Awaiting PO', warn: false
      },
      {
        n: orders.filter(function (o) { return o.status === 'production_confirmed'; }).length,
        l: 'In production', warn: false
      },
      { n: stale.length, l: 'Over ' + STALE_DAYS + ' days', warn: stale.length > 0 }
    ];
  }

  function renderDashboard() {
    var r = clear(root());

    r.appendChild(el('div', { class: 'admin-head' }, [
      el('div', {}, [
        el('h1', { text: 'Label orders' }),
        el('div', {
          class: 'sub',
          text: state.orders.length
            ? state.orders.length + ' order' + (state.orders.length === 1 ? '' : 's') + ' on file'
            : 'No orders on file yet'
        })
      ]),
      el('button', {
        class: 'ghost',
        onclick: function () { loadOrders(); }
      }, 'Refresh')
    ]));

    var stats = el('div', { class: 'stats' });
    statsFor(state.orders).forEach(function (s) {
      stats.appendChild(el('div', { class: 'stat' + (s.warn ? ' warn' : '') }, [
        el('div', { class: 'n', text: String(s.n) }),
        el('div', { class: 'l', text: s.l })
      ]));
    });
    r.appendChild(stats);

    var filters = el('div', { class: 'filters' });
    FILTERS.forEach(function (f) {
      filters.appendChild(el('button', {
        class: 'filter' + (state.filter === f.key ? ' on' : ''),
        'aria-pressed': state.filter === f.key ? 'true' : 'false',
        onclick: function () { state.filter = f.key; render(); }
      }, f.label));
    });

    var search = el('input', {
      type: 'search',
      placeholder: 'Search reference, company, or contact',
      'aria-label': 'Search orders',
      value: state.query
    });
    search.addEventListener('input', function () {
      state.query = search.value;
      renderTable();
    });
    r.appendChild(el('div', { class: 'toolbar' }, [search, filters]));

    if (state.loadError) {
      r.appendChild(el('div', { class: 'form-error', role: 'alert', text: state.loadError }));
    }

    var scroll = el('div', { class: 'table-scroll', id: 'tableScroll' });
    r.appendChild(scroll);
    renderTable();

    if (state.drawerId) r.appendChild(renderDrawer());
    if (state.recordId) r.appendChild(renderRecord());

    function renderTable() {
      var host = document.getElementById('tableScroll');
      if (!host) return;
      clear(host);
      var visible = visibleOrders();
      if (!visible.length) {
        host.appendChild(el('div', {
          class: 'empty',
          text: state.orders.length
            ? 'No orders match this filter.'
            : 'Orders submitted through the customer form will appear here.'
        }));
        return;
      }

      var thead = el('thead', {}, el('tr', {}, [
        el('th', { text: 'Reference' }),
        el('th', { text: 'Customer' }),
        el('th', { text: 'Received' }),
        el('th', { class: 'num', text: 'Qty' }),
        el('th', { text: 'Label' }),
        el('th', { text: 'Status' }),
        el('th', { class: 'actions-cell', text: 'Actions' })
      ]));

      var tbody = el('tbody');
      visible.forEach(function (o) {
        var days = daysSince(o.submitted_at);
        var stale = isOpen(o) && days !== null && days >= STALE_DAYS;

        var select = el('select', {
          class: 'status-select',
          'data-status': o.status,
          'aria-label': 'Status for order ' + o.order_ref,
          disabled: state.busyRows[o.id] ? 'disabled' : null
        });
        STATUSES.forEach(function (s) {
          var opt = el('option', { value: s.value, text: s.label });
          if (s.value === o.status) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener('change', function () {
          setStatus(o, select.value, select);
        });

        // The whole row opens the drawer, not just the Details link -- but not
        // when the click landed on the status dropdown, which has its own job.
        var tr = el('tr', {
          class: 'row',
          tabindex: '0',
          'aria-label': 'Order ' + o.order_ref + ', ' + (o.company_name || 'no company')
        });
        function openDrawer() { state.drawerId = o.id; render(); }
        tr.addEventListener('click', function (e) {
          if (e.target.closest('select,button')) return;
          openDrawer();
        });
        tr.addEventListener('keydown', function (e) {
          if (e.target !== tr) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openDrawer();
        });
        [
          el('td', { class: 'ref-cell', text: o.order_ref }),
          el('td', { class: 'company-cell' }, [
            document.createTextNode(o.company_name || '—'),
            el('span', { class: 'contact', text: o.contact_name || '' })
          ]),
          el('td', { class: 'date-cell' }, [
            document.createTextNode(fmtDate(o.submitted_at)),
            el('span', { class: 'age' + (stale ? ' stale' : ''), text: ageText(o) })
          ]),
          el('td', { class: 'num', text: o.quantity == null ? '—' : String(o.quantity) }),
          el('td', { text: labelSpec(o) }),
          el('td', {}, select),
          el('td', { class: 'actions-cell' }, rowActions(o, openDrawer))
        ].forEach(function (cell) { tr.appendChild(cell); });
        tbody.appendChild(tr);

        if (state.rowErrors[o.id]) {
          tbody.appendChild(el('tr', {}, el('td', {
            class: 'row-error', colspan: '7', role: 'alert',
            text: state.rowErrors[o.id]
          })));
        }
      });

      host.appendChild(el('table', { class: 'orders' }, [thead, tbody]));
    }
  }

  /**
   * The per-row actions.
   *
   * Artwork, the PO inputs and the signed record are wanted on nearly every
   * order, and reaching them through the modal was three clicks for each. They
   * live on the row now; the modal keeps its own copies for when it is already
   * open.
   *
   * "PDF" opens the record and goes straight to the print dialogue, which is
   * where a PDF actually comes from -- there is no way to hand over a file
   * without the browser's own save step, and adding a PDF library to do it
   * would render a second, drifting version of the document.
   */
  function rowActions(order, openDrawer) {
    var wrap = el('div', { class: 'row-actions' });

    var hasArtwork = order.logo_choice === 'custom_logo';
    var logoBtn = el('button', {
      title: hasArtwork
        ? 'Download the customer artwork (' + (order.logo_file_name || 'file') + ')'
        : 'This order has no uploaded artwork',
      disabled: hasArtwork ? null : 'disabled'
    }, 'Logo');
    if (hasArtwork) {
      logoBtn.addEventListener('click', function () {
        // Errors surface on the row rather than in a modal nobody opened.
        var statusEl = { set textContent(v) { state.rowErrors[order.id] = v; render(); } };
        downloadArtwork(order, logoBtn, statusEl, 'Logo');
      });
    }
    wrap.appendChild(logoBtn);

    var inputsBtn = el('button', { title: 'Download the Ramp PO inputs as JSON' }, 'Inputs');
    inputsBtn.addEventListener('click', function () {
      downloadPoInputs([order], order.order_ref + '-ramp-po-input.json');
    });
    wrap.appendChild(inputsBtn);

    var pdfBtn = el('button', {
      title: 'Open the signed authorization record and print or save it as a PDF'
    }, 'PDF');
    pdfBtn.addEventListener('click', function () { openRecord(order, true, 'vendor'); });
    wrap.appendChild(pdfBtn);

    var detailsBtn = el('button', { title: 'Open the full order' }, 'Details');
    detailsBtn.addEventListener('click', openDrawer);
    wrap.appendChild(detailsBtn);

    return wrap;
  }

  /**
   * The authorization record, as the customer sees it.
   *
   * Deliberately built from the same review-block markup and print stylesheet
   * the customer form uses, so what staff read back is the document that was
   * signed rather than a second rendering of it that could drift. There is no
   * PDF library here and does not need to be: the browser's own print dialogue
   * saves to PDF, and that keeps the page free of another CDN dependency.
   */
  function renderRecord() {
    var order = state.orders.filter(function (o) { return o.id === state.recordId; })[0];
    if (!order) return el('div');

    function close() { state.recordId = null; render(); }

    var overlay = el('div', {
      class: 'record-overlay',
      onclick: function (e) { if (e.target === overlay) close(); }
    });

    var vendor = state.recordAudience !== 'record';
    var title = vendor
      ? 'Vendor copy for ' + order.order_ref
      : 'Authorization record for ' + order.order_ref;

    var sheet = el('div', {
      class: 'record-sheet',
      role: 'dialog',
      'aria-label': title
    });

    sheet.appendChild(el('div', { class: 'record-actions' }, [
      el('span', { class: 'record-which no-print', text: title }),
      el('button', { class: 'primary', onclick: printOpenRecord },
        'Print / save as PDF'),
      el('button', { class: 'ghost', onclick: close }, 'Close')
    ]));

    // Rendered by the shared module rather than rebuilt here. Reproducing a
    // signed document from a second template is how a read-back stops matching
    // the thing that was signed.
    var doc = el('div', { class: 'record-doc' });
    var mod = window.TOOLHOUND_ORDER_DOC;
    if (mod) {
      doc.appendChild(mod.render(mod.fromRow(order),
        { audience: vendor ? 'vendor' : 'record' }));
    } else {
      doc.appendChild(el('div', { class: 'form-error',
        text: 'The order document could not be rendered: order-doc.js did not '
          + 'load. Reload the page; if it persists the deploy is incomplete.' }));
    }

    sheet.appendChild(doc);
    overlay.appendChild(sheet);
    return overlay;
  }

  function renderDrawer() {
    var order = state.orders.filter(function (o) { return o.id === state.drawerId; })[0];
    if (!order) return el('div');

    function close() {
      state.drawerId = null;
      state.confirmDeleteId = null;
      render();
    }

    var backdrop = el('div', {
      class: 'drawer-backdrop',
      onclick: function (e) { if (e.target === backdrop) close(); }
    });

    var drawer = el('div', {
      class: 'drawer',
      role: 'dialog',
      'aria-label': 'Order ' + order.order_ref
    });

    drawer.appendChild(el('div', { class: 'drawer-head' }, [
      el('div', {}, [
        el('h2', { text: order.order_ref }),
        el('div', { class: 'sub', text: order.company_name || '' })
      ]),
      el('button', { class: 'ghost', onclick: close }, 'Close')
    ]));

    // Timeline. A stage with no timestamp has not happened, which is why the
    // trigger clears stamps when an order is moved backwards.
    var timeline = el('ul', { class: 'timeline' });
    [
      ['Submitted', order.submitted_at],
      ['PO sent', order.po_sent_at],
      ['Production confirmed', order.production_confirmed_at],
      ['Shipped', order.shipped_at]
    ].concat(order.cancelled_at ? [['Cancelled', order.cancelled_at]] : [])
      .forEach(function (pair) {
        var done = !!pair[1];
        timeline.appendChild(el('li', { class: done ? '' : 'pending' }, [
          el('span', { class: 'k', text: pair[0] }),
          el('span', { class: 'v', text: done ? fmtDateTime(pair[1]) : 'not yet' })
        ]));
      });
    drawer.appendChild(timeline);

    function section(title, pairs) {
      drawer.appendChild(el('div', { class: 'review-block' }, [el('h3', { text: title })].concat(
        pairs.map(function (p) {
          return el('div', { class: 'review-row' }, [
            el('span', { class: 'k', text: p[0] }),
            el('span', { class: 'v', text: p[1] == null || p[1] === '' ? '—' : String(p[1]) })
          ]);
        })
      )));
    }

    section('Customer', [
      ['Company', order.company_name],
      ['Contact', order.contact_name],
      ['Email', order.contact_email],
      ['Ship to', [order.address, order.city, order.state_province, order.postal_code, order.country]
        .filter(Boolean).join(', ')],
      ['Receiving contact', order.attention_name],
      ['Delivery phone', order.ship_to_phone],
      ['Their PO number', order.customer_po]
    ]);

    section('Specification', [
      ['Label', labelSpec(order)],
      ['Full colour', order.full_color],
      ['Label type', labelTypeText(order)],
      ['Label size', labelSize(order)],
      ['Quantity', order.quantity],
      ['Sequence range', sequenceRange(order)],
      ['Special instructions', order.instructions]
    ]);

    section('Authorization', [
      ['Authorized by', order.authorized_name],
      ['Approval date', fmtDate(order.approval_date)],
      ['Current status', STATUS_LABELS[order.status] || order.status],
      ['Last updated', fmtDateTime(order.updated_at)]
    ]);

    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Vendor PO' }),
      el('button', {
        class: 'primary',
        onclick: function () {
          downloadPoInputs([order], order.order_ref + '-ramp-po-input.json');
        }
      }, 'Download PO inputs'),
      el('div', {
        class: 'artwork-note',
        text: 'A JSON file with everything needed for the Metalcraft PO. Hand '
          + 'it to Claude and ask for the Ramp PO. The unit price is not in it '
          + 'and does not need to be — these POs go out at 0.00, because '
          + 'Metalcraft invoices once they have the PO.'
      })
    ]));

    if (order.signature_data) {
      drawer.appendChild(el('div', { class: 'review-block' }, [
        el('h3', { text: 'Signature' }),
        el('img', {
          class: 'sig-view',
          src: order.signature_data,
          alt: 'Signature of ' + (order.authorized_name || 'the authorizing customer')
        })
      ]));
    }

    if (order.logo_choice === 'custom_logo') {
      var artworkStatus = el('div', { class: 'hint', role: 'status' });
      var artworkBtn = el('button', { class: 'primary' }, 'Download artwork');
      artworkBtn.addEventListener('click', function () {
        downloadArtwork(order, artworkBtn, artworkStatus);
      });
      drawer.appendChild(el('div', { class: 'review-block' }, [
        el('h3', { text: 'Artwork' }),
        el('div', { class: 'review-row' }, [
          el('span', { class: 'k', text: 'File' }),
          el('span', { class: 'v', text: order.logo_file_name || '—' })
        ]),
        el('div', { style: 'margin-top:12px' }, artworkBtn),
        artworkStatus,
        el('div', {
          class: 'artwork-note',
          text: 'Artwork downloads rather than previewing here. Customer uploads '
            + 'include SVG, which can carry script, so it is never rendered inside '
            + 'this page. Open it in a design tool, not a browser tab.'
        })
      ]));
    }

    // Editable because a sequence can legitimately be unknown: Phoenix's next
    // run has to pick up where the last one ended, and only Metalcraft know
    // where that was. A placeholder left in the field is worse than a blank --
    // it looks valid and would re-issue numbers the customer already has.
    var seqInput = el('input', {
      type: 'text',
      'aria-label': 'Starting label number',
      placeholder: 'e.g. 45001, TSG-0001 — blank until confirmed'
    });
    seqInput.value = order.seq_start || '';
    var seqStatus = el('div', { class: 'hint', role: 'status' });
    var seqBtn = el('button', {}, 'Save sequence');
    seqBtn.addEventListener('click', function () {
      saveOrderPatch(order, { seq_start: seqInput.value.trim() || null },
        seqBtn, seqStatus, 'Save sequence');
    });
    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Starting label number' }),
      el('div', { class: 'field' }, [seqInput]),
      seqBtn,
      el('div', {
        class: 'artwork-note',
        text: 'Letters, numbers and hyphens, ending in a digit. Leave blank '
          + 'while the continuation point is still with the supplier: the '
          + 'vendor copy then says the sequence is to be confirmed rather '
          + 'than printing a number nobody has agreed.'
      }),
      seqStatus
    ]));

    var adhesiveInput = el('input', {
      type: 'text',
      'aria-label': 'Adhesive',
      placeholder: 'e.g. Pressure Sensitive Acrylic Adhesive'
    });
    adhesiveInput.value = order.adhesive || '';
    var adhesiveStatus = el('div', { class: 'hint', role: 'status' });
    var adhesiveBtn = el('button', {}, 'Save adhesive');
    adhesiveBtn.addEventListener('click', function () {
      saveOrderPatch(order, { adhesive: adhesiveInput.value.trim() || null },
        adhesiveBtn, adhesiveStatus, 'Save adhesive');
    });
    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Adhesive' }),
      el('div', { class: 'field' }, [adhesiveInput]),
      adhesiveBtn,
      el('div', {
        class: 'artwork-note',
        text: 'Prints on the vendor copy. Staff-set rather than asked on the '
          + 'form, because it is agreed with Metalcraft and a customer has no '
          + 'way to know it. Blank prints as a dash.'
      }),
      adhesiveStatus
    ]));

    var notesArea = el('textarea', { rows: '4', 'aria-label': 'Internal notes' });
    notesArea.value = order.internal_notes || '';
    var notesStatus = el('div', { class: 'hint', role: 'status' });
    var notesBtn = el('button', { class: 'primary' }, 'Save notes');
    notesBtn.addEventListener('click', function () {
      saveOrderPatch(order, { internal_notes: notesArea.value.trim() || null },
        notesBtn, notesStatus, 'Save notes');
    });
    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Internal notes' }),
      el('div', { class: 'field' }, [notesArea]),
      notesBtn,
      notesStatus
    ]));

    var emailStatus = el('div', { class: 'hint', role: 'status' });
    var emailBtn = el('button', {
      onclick: function () { copyOrderForEmail(order, emailBtn, emailStatus); }
    }, 'Copy for email');

    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Send to Metalcraft' }),
      el('div', { class: 'record-buttons' }, [
        el('button', {
          class: 'primary',
          onclick: function () { openRecord(order, false, 'vendor'); }
        }, 'Vendor copy / PDF'),
        emailBtn
      ]),
      el('div', {
        class: 'artwork-note',
        text: 'The specification only: no proof or invoice routing and no '
          + 'signed authorisation, because none of that is the supplier\u2019s '
          + 'to act on.'
      }),
      emailStatus
    ]));

    drawer.appendChild(el('div', { class: 'review-block' }, [
      el('h3', { text: 'Authorization record' }),
      el('button', {
        onclick: function () { openRecord(order, false, 'record'); }
      }, 'View signed record'),
      el('div', {
        class: 'artwork-note',
        text: 'Kept internally: the document the customer reviewed and signed, '
          + 'exactly as they saw it, including the signature. This is the '
          + 'evidence that a nonreturnable order was authorised.'
      })
    ]));

    // Deleting removes a signed authorization and there is no undo, so it sits
    // at the bottom, behind two clicks, and names the order in the warning.
    var delStatus = el('div', { class: 'hint', role: 'status' });
    var danger = el('div', { class: 'review-block danger' }, [
      el('h3', { text: 'Delete order' })
    ]);
    if (state.confirmDeleteId === order.id) {
      var confirmBtn = el('button', { class: 'danger' }, 'Delete permanently');
      confirmBtn.addEventListener('click', function () {
        deleteOrder(order, confirmBtn, delStatus);
      });
      danger.appendChild(el('div', {
        class: 'danger-warn',
        role: 'alert',
        text: 'Permanently delete ' + order.order_ref + ' (' + (order.company_name || 'no company')
          + ')? This removes the signed authorization and the artwork. It cannot be undone.'
      }));
      danger.appendChild(el('div', { class: 'danger-row' }, [
        confirmBtn,
        el('button', {
          class: 'ghost',
          onclick: function () { state.confirmDeleteId = null; render(); }
        }, 'Keep it')
      ]));
    } else {
      danger.appendChild(el('button', {
        class: 'danger-outline',
        onclick: function () { state.confirmDeleteId = order.id; render(); }
      }, 'Delete this order'));
    }
    danger.appendChild(delStatus);
    drawer.appendChild(danger);

    backdrop.appendChild(drawer);
    return backdrop;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function render() {
    renderUserSlot();
    if (state.phase === 'loading') {
      clear(root()).appendChild(el('p', { class: 'admin-loading', text: 'Loading…' }));
      return;
    }
    if (state.phase === 'config_error') return renderConfigError();
    if (state.phase === 'signed_out') return renderSignedOut();
    if (state.phase === 'denied') return renderDenied();
    renderDashboard();
  }

  function applySession() {
    if (!state.session) {
      state.phase = 'signed_out';
      state.email = '';
      state.orders = [];
      render();
      return;
    }
    state.email = signedInEmail();
    if (!domainAllowed(state.email)) {
      state.phase = 'denied';
      state.orders = [];
      render();
      return;
    }
    state.phase = 'ready';
    render();
    loadOrders();
  }

  function boot() {
    render();

    // Escape closes whatever is on top. Without it the only way out of the
    // drawer is finding the Close button, which is the kind of small friction
    // that makes a dashboard tiring to work in.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.recordId) { state.recordId = null; render(); return; }
      if (state.confirmDeleteId) { state.confirmDeleteId = null; render(); return; }
      if (state.drawerId) { state.drawerId = null; render(); }
    });
    authError = authErrorFromUrl();
    client = getClient();
    if (!client) {
      state.phase = 'config_error';
      render();
      return;
    }

    // Sign-in happens through a redirect (Google) or an emailed link, so the
    // page has to react to the session appearing rather than only reading it
    // once at load.
    if (client.auth.onAuthStateChange) {
      client.auth.onAuthStateChange(function (event, session) {
        var next = session || null;
        var nextEmail = String((next && next.user && next.user.email) || '').toLowerCase();
        // Supabase fires this for token refreshes as well as sign-in and
        // sign-out. Reacting to every one of them would refetch the whole
        // table on the refresh timer, so only an identity change is acted on.
        var changed = nextEmail !== state.email;
        state.session = next;
        if (changed) applySession();
      });
    }

    Promise.resolve(client.auth.getSession()).then(function (res) {
      state.session = (res && res.data && res.data.session) || null;
      applySession();
    }).catch(function (err) {
      console.error('Could not read the session', err);
      state.session = null;
      applySession();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
