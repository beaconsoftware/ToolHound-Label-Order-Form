window.ToolHoundIntake = { mount: async function (root, client, session) {
  'use strict';
  var pendingId = sessionStorage.getItem('toolhound-intake-pending');
  var busy = false;
  var refreshHistory = async function () {};
  var updateRequest = function () {};
  var markSent = async function () {};
  var pendingWrites = new Set();
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function field(parent, label, id, type, required) {
    var box = el('div');
    box.appendChild(el('label', { for: id }, label));
    var input = el('input', { id: id, name: id, type: type || 'text', maxlength: '200' });
    if (required) input.required = true;
    box.appendChild(input); parent.appendChild(box); return input;
  }
  async function api(body) {
    var result = await client.functions.invoke('order-requests', { body: body });
    if (result.error) {
      var detail;
      try { detail = await result.error.context.json(); } catch (_) { /* network error */ }
      throw new Error((detail && detail.error) || result.error.message || 'Request failed. Please retry.');
    }
    if (result.data.error) throw new Error(result.data.error);
    return result.data;
  }
  function notice(node, message) { node.textContent = message; node.hidden = false; }
  async function ready() {
    var card = el('section', { class: 'card' });
    card.appendChild(el('h2', {}, 'New customer request'));
    var form = el('form'); var grid = el('div', { class: 'intake-grid' });
    var company = field(grid, 'Company name *', 'company', 'text', true);
    var contact = field(grid, 'Contact name *', 'contact', 'text', true);
    var email = field(grid, 'Contact email *', 'email', 'email', true);
    var crm = field(grid, 'CRM link (internal only)', 'crm', 'url'); crm.maxLength = 2000;
    var typeBox = el('div'); typeBox.appendChild(el('label', { for: 'order-type' }, 'Label order type *'));
    var type = el('select', { id: 'order-type', required: '' });
    [['','Choose a label form'],['linear','Linear barcode labels'],['qr','QR code labels']].forEach(function (o) { type.appendChild(el('option', { value: o[0] }, o[1])); });
    typeBox.appendChild(type); grid.appendChild(typeBox);
    var quote = field(grid, 'Completed quote PDF *', 'quote', 'file', true); quote.accept = 'application/pdf,.pdf';
    form.appendChild(grid);
    form.appendChild(el('p', { class: 'hint' }, 'PDF up to 10 MB. The quote is saved as version 1 of this request. Send the quote and customer link yourself after reviewing them.'));
    var button = el('button', { type: 'submit', class: 'primary' }, 'Prepare customer link'); form.appendChild(button);
    var feedback = el('div', { class: 'intake-message', role: 'status', hidden: '' }); form.appendChild(feedback);
    var resultBox = el('div');
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); if (busy) return;
      var file = quote.files[0];
      if (!file || file.size > 10 * 1024 * 1024) { notice(feedback, 'Choose a completed quote PDF up to 10 MB.'); return; }
      busy = true; button.disabled = true;
      // Persist before the first network operation; uncertain results never get
      // a fresh ID. Recover the saved request before starting another one.
      if (!pendingId) { pendingId = crypto.randomUUID(); sessionStorage.setItem('toolhound-intake-pending', pendingId); }
      notice(feedback, 'Saving the quote and preparing the request…');
      try {
        var base64 = await new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result.split(',')[1]); }; reader.onerror = reject; reader.readAsDataURL(file); });
        var saved = await api({ action: 'create', id: pendingId, company_name: company.value, contact_name: contact.value,
          contact_email: email.value, salesforce_url: crm.value, barcode_type: type.value, quote_name: file.name, quote_data: base64 });
        updateRequest(saved); showLink(resultBox, saved);
        notice(feedback, 'Request saved. Review the company, quote and link below before sending.');
        sessionStorage.removeItem('toolhound-intake-pending'); pendingId = null;
        form.reset(); await refreshHistory();
      } catch (err) { notice(feedback, err.message + ' Your request ID is retained; retry or recover it below.'); }
      finally { busy = false; button.disabled = false; }
    });
    card.appendChild(form); card.appendChild(resultBox); root.appendChild(card);
    if (pendingId) {
      var recovery = el('div', { class: 'intake-message' }, 'An earlier request may need recovery.');
      recovery.appendChild(el('button', { class: 'secondary', onclick: async function () {
        try { var saved = await api({ action: 'recover', id: pendingId }); updateRequest(saved); showLink(resultBox, saved); await refreshHistory(); sessionStorage.removeItem('toolhound-intake-pending'); pendingId = null; recovery.remove(); }
        catch (err) { notice(feedback, err.message); }
      } }, 'Recover pending request'));
      root.appendChild(recovery);
    }
    var history = el('section', { class: 'request-history' });
    var heading = el('div', { class: 'request-history-head' });
    var title = el('div');
    title.appendChild(el('h2', {}, 'Previous requests'));
    var count = el('span', { class: 'request-count' }); title.appendChild(count);
    heading.appendChild(title);
    var refreshButton = el('button', { type: 'button', class: 'secondary request-action', onclick: function () { return refreshHistory(); } }, 'Refresh requests');
    heading.appendChild(refreshButton);
    history.appendChild(heading);
    var toolbar = el('div', { class: 'request-toolbar' });
    var search = el('input', { type: 'search', placeholder: 'Search company, contact or email…', 'aria-label': 'Search requests' });
    var filter = el('select', { 'aria-label': 'Filter requests by status' });
    [['all', 'All requests'], ['awaiting', 'Awaiting customer'], ['expired', 'Expired'], ['submitted', 'Submitted'], ['unsent', 'Not marked sent']].forEach(function (option) {
      filter.appendChild(el('option', { value: option[0] }, option[1]));
    });
    toolbar.appendChild(search); toolbar.appendChild(filter); history.appendChild(toolbar);
    history.appendChild(el('p', { class: 'request-scroll-hint', id: 'request-scroll-hint' }, 'Scroll the table horizontally to see all columns and actions.'));
    var list = el('div', { 'aria-describedby': 'request-scroll-hint', class: 'request-table-scroll', tabindex: '0', 'aria-label': 'Request history' });
    var rows = [];
    var historyLoaded = false;
    var revision = 0, readSequence = 0;
    updateRequest = function (saved) {
      revision++;
      historyLoaded = true;
      var index = rows.findIndex(function (row) { return row.id === saved.id; });
      if (index < 0) rows.unshift(saved);
      else rows[index] = Object.assign({}, rows[index], saved);
      renderHistory();
    };
    markSent = async function (id, recipient, sentAt) {
      if (pendingWrites.has(id)) throw new Error('This request is already saving.');
      var previous = rows.find(function (row) { return row.id === id; });
      pendingWrites.add(id);
      updateRequest({ id: id, sent_at: sentAt, sent_recipient: recipient });
      try {
        await api({ action: 'mark_sent', id: id, recipient: recipient, sent_at: sentAt });
      } catch (err) {
        if (previous) updateRequest(previous);
        throw err;
      } finally {
        pendingWrites.delete(id); revision++; renderHistory();
      }
    };
    var historyStatus = el('p', { role: 'status', class: 'request-history-status' });
    history.appendChild(historyStatus); history.appendChild(list);
    var dialog = el('dialog', { class: 'request-link-dialog', 'aria-labelledby': 'request-link-title' });
    var dialogHead = el('div', { class: 'request-dialog-head' });
    dialogHead.appendChild(el('h2', { id: 'request-link-title' }, 'Customer link'));
    dialogHead.appendChild(el('button', { type: 'button', class: 'secondary request-action', onclick: function () { dialog.close(); } }, 'Close'));
    var dialogBody = el('div'); dialog.appendChild(dialogHead); dialog.appendChild(dialogBody); history.appendChild(dialog);
    function stateOf(r) {
      if (r.submitted_at) return ['submitted', 'Submitted'];
      if (r.revoked_at) return ['revoked', 'Revoked'];
      if (new Date(r.expires_at).getTime() <= Date.now()) return ['expired', 'Expired'];
      if (r.request_state !== 'ready') return ['pending', 'Preparation incomplete'];
      if (r.sent_at && (!r.regenerated_at || r.sent_at >= r.regenerated_at)) return ['awaiting', 'Awaiting customer'];
      return ['unsent', 'Not marked sent'];
    }
    function date(value) { return value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
    function renderHistory() {
      list.replaceChildren();
      if (!historyLoaded) {
        list.appendChild(el('div', { class: 'table-loading-placeholder', 'aria-hidden': 'true' }));
        return;
      }
      var query = search.value.toLowerCase();
      var matches = rows.filter(function (r) { return [r.company_name, r.contact_name, r.contact_email].join(' ').toLowerCase().includes(query) && (filter.value === 'all' || stateOf(r)[0] === filter.value); });
      count.textContent = rows.length + (rows.length === 1 ? ' request' : ' requests');
      var table = el('table', { class: 'request-table' });
      var head = el('thead'); var header = el('tr');
      ['Customer', 'Quote / form', 'Status', 'Last sent', 'Expires', 'Actions'].forEach(function (name) { header.appendChild(el('th', { scope: 'col' }, name)); });
      head.appendChild(header); table.appendChild(head);
      var body = el('tbody'); table.appendChild(body); list.appendChild(table);
      if (!matches.length) { var empty = el('tr'); empty.appendChild(el('td', { colspan: '6', class: 'request-empty' }, rows.length ? 'No requests match your search.' : 'No requests yet. Prepared customer links will appear here.')); body.appendChild(empty); }
      matches.forEach(function (r) {
        var item = el('tr');
        var customer = el('td');
        customer.appendChild(el('strong', {}, r.company_name));
        customer.appendChild(el('span', { class: 'request-secondary' }, r.contact_name));
        customer.appendChild(el('span', { class: 'request-secondary' }, r.contact_email));
        item.appendChild(customer);
        var quote = el('td'); quote.appendChild(el('a', { class: 'request-quote', title: 'Open ' + r.quote_name, href: '/quote.html?request=' + encodeURIComponent(r.id), target: '_blank', rel: 'noopener' }, r.quote_name));
        quote.appendChild(el('span', { class: 'request-secondary' }, (r.barcode_type === 'qr' ? 'QR code' : 'Linear barcode') + ' · v' + r.quote_version));
        (r.integrations || []).forEach(function (integration) {
          if (integration.url) quote.appendChild(el('a', { href: integration.url, target: '_blank', rel: 'noopener', class: 'request-ticket' }, integration.identifier || integration.provider));
        });
        item.appendChild(quote);
        var state = stateOf(r);
        var status = el('td'); status.appendChild(el('span', { class: 'request-badge request-badge-' + state[0] }, state[1]));
        if (pendingWrites.has(r.id)) status.appendChild(el('span', { class: 'request-secondary', role: 'status' }, 'Saving…'));
        if (r.sync_pending) status.appendChild(el('span', { class: 'request-secondary' }, 'Sync pending · link is usable'));
        (r.integrations || []).forEach(function (integration) { if (integration.error) status.appendChild(el('span', { class: 'request-secondary' }, integration.provider + ': ' + integration.error)); });
        if (r.mode === 'shadow') status.appendChild(el('span', { class: 'request-secondary' }, 'Test request'));
        if (r.submitted_at) status.appendChild(el('span', { class: 'request-secondary' }, 'Submitted: ' + date(r.submitted_at)));
        item.appendChild(status);
        var sent = el('td', { title: r.sent_at ? 'Last marked sent: ' + new Date(r.sent_at).toLocaleString() + ' · ' + r.sent_recipient : 'Not marked sent' }, date(r.sent_at));
        if (r.sent_at) sent.appendChild(el('span', { class: 'request-secondary' }, r.sent_recipient));
        item.appendChild(sent); item.appendChild(el('td', { class: state[0] === 'expired' ? 'request-expired' : '' }, r.submitted_at ? '—' : date(r.expires_at)));
        var actions = el('td', { class: 'request-actions' });
        var feedback = el('p', { role: 'status', class: 'request-action-status' });
        function action(label, name) {
          var actionButton = el('button', { type: 'button', class: 'secondary request-action', onclick: async function (event) {
            var button = event.currentTarget; if (pendingWrites.has(r.id)) return; button.disabled = true; feedback.textContent = '';
            revision++;
            try {
              var saved = await api({ action: name, id: r.id, token_version: r.token_version });
              if (saved.id) updateRequest(saved);
              if (saved.customer_url) {
                dialogBody.replaceChildren();
                if (name === 'regenerate') dialogBody.appendChild(el('p', { class: 'request-success' }, 'Replacement link generated. The previous link no longer works.'));
                showLink(dialogBody, saved); dialog.showModal();
              }
              if (name === 'recover' && pendingId === r.id) { sessionStorage.removeItem('toolhound-intake-pending'); pendingId = null; if (recovery) recovery.remove(); }

              await refreshHistory();
            } catch (err) { feedback.textContent = err.message; }
            finally { button.disabled = false; }
          } }, label);
          actionButton.disabled = pendingWrites.has(r.id);
          actions.appendChild(actionButton);
        }
        if (!r.submitted_at && !r.revoked_at) {
          if (r.request_state !== 'ready') action('Retry preparation', 'recover');
          else if (state[0] === 'expired') action('Regenerate link', 'regenerate');
          else action('Show link', 'recover');
        } else if (r.order_ref) actions.appendChild(el('span', { class: 'request-secondary' }, r.order_ref));
        if (r.sync_pending) action('Retry sync', 'sync');
        actions.appendChild(feedback); item.appendChild(actions); body.appendChild(item);
      });
    }
    filter.addEventListener('change', renderHistory);
    search.addEventListener('input', renderHistory);
    refreshHistory = async function () {
      var sequence = ++readSequence, startedAt = revision;
      list.setAttribute('aria-busy', 'true');
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
      historyStatus.className = 'request-history-status table-loading';
      historyStatus.textContent = historyLoaded ? 'Refreshing requests…' : 'Loading requests…';
      if (!historyLoaded) renderHistory();
      try {
        var result = await api({ action: 'list' });
        if (sequence !== readSequence || startedAt !== revision || pendingWrites.size) return;
        rows = result.requests;
        historyLoaded = true;
        historyStatus.textContent = rows.length === 250 ? 'Showing the latest 250 requests.' : '';
        renderHistory();
      } catch (err) { if (sequence === readSequence) historyStatus.textContent = 'Could not refresh requests. ' + err.message; }
      finally {
        if (sequence === readSequence) {
          list.setAttribute('aria-busy', 'false');
          refreshButton.disabled = false;
          refreshButton.textContent = 'Refresh requests';
          historyStatus.className = 'request-history-status';
          if (/^(Loading|Refreshing) requests/.test(historyStatus.textContent)) historyStatus.textContent = '';
        }
      }
    };
    root.appendChild(history);
    await refreshHistory();

  }
  function showLink(parent, r) {
    var old = parent.querySelector('.link-result'); if (old) old.remove();
    var box = el('div', { class: 'link-result intake-message' });
    if (r.mode === 'shadow') box.appendChild(el('p', { class: 'shadow-banner' }, 'Test request: no external record or production order is created. Use only with test customers.'));
    if (r.sync_pending) box.appendChild(el('p', { role: 'status' }, 'Customer link is ready. External sync is pending; you can send the link now.'));
    box.appendChild(el('p', {}, r.company_name + ' · ' + r.quote_name + ' · v' + r.quote_version));
    var link = field(box, 'Customer link', 'link-' + r.id); link.value = r.customer_url; link.readOnly = true;
    var message = el('p', { role: 'status' });
    var linkActions = el('div', { class: 'customer-link-actions' });
    box.appendChild(linkActions);
    linkActions.appendChild(el('button', { type: 'button', class: 'secondary', onclick: async function () {
      try { await navigator.clipboard.writeText(r.customer_url); message.textContent = 'Link copied.'; } catch (_) { link.select(); message.textContent = 'Select and copy the link above.'; }
    } }, 'Copy link'));
    linkActions.appendChild(el('a', { class: 'secondary', href: r.customer_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open customer form'));
    if (!r.submitted_at) {
      var sentForm = el('form', { class: 'request-sent-form' });
      var recipient = field(sentForm, 'Sent to', 'sent-to-' + r.id, 'email', true); recipient.value = r.sent_recipient || r.contact_email;
      var time = field(sentForm, 'Time you sent the email', 'sent-at-' + r.id, 'datetime-local', true);
      time.step = '1';
      time.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,19);
      var send = el('button', { type: 'submit', class: 'primary' }, 'Mark form sent'); sentForm.appendChild(send);
      sentForm.addEventListener('submit', async function (e) {
        e.preventDefault(); if (send.disabled) return; send.disabled = true; send.textContent = 'Saving…'; message.textContent = 'Saving sent details…';
        try { await markSent(r.id, recipient.value, new Date(time.value).toISOString()); message.textContent = 'Marked sent. Delivery has not been verified.'; }
        catch (err) { message.textContent = err.message; }
        finally { send.disabled = false; send.textContent = 'Mark form sent'; }
      }); box.appendChild(sentForm);
    } else box.appendChild(el('p', {}, 'Already submitted. This link cannot create another order.'));
    box.appendChild(message); parent.appendChild(box);
  }
  root.replaceChildren();
  try { await ready(); } catch (_) { root.textContent = 'Could not load order preparation. Please reload to retry.'; }
}};
