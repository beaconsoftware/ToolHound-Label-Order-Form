/**
 * The label order document, as Metalcraft receives it.
 *
 * This is the only rendering of that document. Both callers use it: the public
 * form prints it as the customer's copy on the confirmation screen, and the
 * dashboard reproduces it so staff read back exactly what was signed. Two
 * templates for one signed document is two templates that drift, and the one
 * that drifts is always the one nobody prints.
 *
 * The two callers hold the order in different shapes -- the form keeps camelCase
 * state, the dashboard reads snake_case rows straight out of Postgres -- so the
 * normalised shape this file wants is defined here, with an adapter for each
 * caller. That keeps the knowledge of what the document needs in one place
 * instead of spread across both.
 *
 * Deliberately absent, on Ian's instruction: ToolHound's postal address (the
 * customer's shipping address is the only address on the sheet), symbology,
 * ship-via and required-by. The reference is ToolHound's own quote number.
 */
(function () {
  'use strict';

  var LOGO_LABELS = {
    toolhound_logo: 'ToolHound logo',
    custom_logo: 'Customer logo supplied',
    custom_text: 'Text only'
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'text') node.textContent = String(v);
      else node.setAttribute(k, v);
    });
    (children == null ? [] : [].concat(children)).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function txt(v) {
    return v == null || v === '' ? '' : String(v);
  }

  /**
   * Split a typed sequence into the four columns Metalcraft's own order
   * confirmation uses. Their table reads Prefix / From / To / Suffix, so the
   * document reads that way too and their order desk has nothing to translate.
   *
   * `TSG-0001` over 500 gives prefix TSG-, from 0001, to 0500. Padding is the
   * customer's choice and is preserved; a run that outgrows its width gets
   * longer, which is worth seeing rather than silently truncating.
   */
  function splitSequence(seqStart, quantity) {
    var start = txt(seqStart).trim();
    var qty = parseInt(String(quantity == null ? '' : quantity).trim(), 10);
    if (!start) return null;

    var m = /^(.*?)(\d+)([^\d]*)$/.exec(start);
    if (!m) return { prefix: start, from: '', to: '', suffix: '', count: qty || null };

    var prefix = m[1];
    var digits = m[2];
    var suffix = m[3];
    var to = '';
    if (isFinite(qty) && qty >= 1) {
      var endDigits = String(parseInt(digits, 10) + qty - 1);
      while (endDigits.length < digits.length) endDigits = '0' + endDigits;
      to = endDigits;
    }
    return {
      prefix: prefix,
      from: digits,
      to: to,
      suffix: suffix,
      count: isFinite(qty) ? qty : null
    };
  }

  /** Metalcraft state their die sizes to four decimals. Match them. */
  function dieSize(widthIn, heightIn) {
    var w = parseFloat(widthIn);
    var h = parseFloat(heightIn);
    if (!isFinite(w) || !isFinite(h)) return '';
    return w.toFixed(4) + ' × ' + h.toFixed(4) + ' in';
  }

  function groupThousands(n) {
    var v = parseInt(String(n == null ? '' : n).trim(), 10);
    if (!isFinite(v)) return txt(n);
    return v.toLocaleString('en-CA');
  }

  function colourText(fullColour) {
    var yes = String(fullColour == null ? '' : fullColour).toLowerCase() === 'yes';
    return yes ? 'Full colour' : '1 — black';
  }

  function addressLines(o) {
    var lines = [];
    if (o.address) lines.push(o.address);
    var cityLine = [o.city, [o.stateProvince, o.postalCode].filter(Boolean).join('  ')]
      .filter(Boolean).join(', ');
    if (cityLine) lines.push(cityLine);
    if (o.country) lines.push(o.country);
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------------------

  /** The public form's in-memory state, plus what only the submission knows. */
  function fromForm(d, meta) {
    meta = meta || {};
    return {
      quoteNumber: d.quoteNumber,
      orderRef: meta.orderRef,
      issuedAt: meta.issuedAt || new Date(),
      companyName: d.companyName,
      address: d.address,
      city: d.city,
      stateProvince: d.stateProvince,
      postalCode: d.postalCode,
      country: d.country,
      attentionName: d.attentionName,
      shipToPhone: d.shipToPhone,
      logoChoice: d.logoChoice,
      logoFileName: d.logoFileName,
      textLines: (d.textLines || []).map(function (l) { return String(l || '').trim(); })
        .filter(function (l) { return l.length > 0; }),
      fullColor: d.fullColor,
      labelWidthIn: d.labelWidthIn,
      labelHeightIn: d.labelHeightIn,
      quantity: d.quantity,
      seqStart: d.seqStart,
      instructions: d.instructions,
      authorizedName: d.authorizedName,
      approvalDate: d.approvalDate,
      signatureData: d.signatureData
    };
  }

  /** A `label_orders` row as the dashboard reads it. */
  function fromRow(row) {
    return {
      quoteNumber: row.quote_number,
      orderRef: row.order_ref,
      issuedAt: row.submitted_at ? new Date(row.submitted_at) : null,
      companyName: row.company_name,
      address: row.address,
      city: row.city,
      stateProvince: row.state_province,
      postalCode: row.postal_code,
      country: row.country,
      attentionName: row.attention_name,
      shipToPhone: row.ship_to_phone,
      logoChoice: row.logo_choice,
      logoFileName: row.logo_file_name,
      textLines: (row.text_lines || []).filter(Boolean),
      fullColor: row.full_color,
      labelWidthIn: row.label_width_in,
      labelHeightIn: row.label_height_in,
      quantity: row.quantity,
      // Older rows predate the typed sequence and carry the integer instead.
      seqStart: row.seq_start != null ? row.seq_start : row.start_seq,
      instructions: row.instructions,
      authorizedName: row.authorized_name,
      approvalDate: row.approval_date,
      signatureData: row.signature_data
    };
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function labelled(label, value) {
    return [
      el('span', { class: 'od-lab', text: label }),
      el('span', { class: 'od-v', text: value === '' ? '—' : value })
    ];
  }

  function sectionBar(title) {
    return el('div', { class: 'od-sec', text: title });
  }

  function fmtDate(v) {
    if (!v) return '';
    var dt = v instanceof Date ? v : new Date(v);
    if (isNaN(dt.getTime())) return String(v);
    try {
      return dt.toLocaleDateString('en-CA',
        { year: 'numeric', month: 'short', day: '2-digit' });
    } catch (e) {
      return dt.toISOString().slice(0, 10);
    }
  }

  /**
   * Build the document. `o` is the normalised shape above; use fromForm or
   * fromRow to produce it.
   */
  function render(o) {
    var cfg = (window.TOOLHOUND_CONFIG || {});
    var by = cfg.orderedBy || {};
    var sup = cfg.supplier || {};
    var stock = cfg.labelStock || '';

    // The reference is the quote number. Where an order predates that field
    // the internal reference stands in rather than leaving the sheet unmarked,
    // because a document with no reference at all is worse than one with an
    // internal one.
    var ref = txt(o.quoteNumber).trim() || txt(o.orderRef).trim();

    var doc = el('div', { class: 'order-doc' });

    // --- masthead ---------------------------------------------------------
    var title = el('div', { class: 'od-title' }, [
      el('div', { class: 'od-dt', text: 'Label Order' })
    ]);
    [['Quote no.', ref], ['Issued', fmtDate(o.issuedAt)], ['Page', '1 of 1']]
      .forEach(function (pair) {
        title.appendChild(el('div', { class: 'od-drow' }, [
          el('span', { class: 'od-lab', text: pair[0] }),
          el('span', { class: 'od-dv', text: pair[1] || '—' })
        ]));
      });

    doc.appendChild(el('div', { class: 'od-head' }, [
      el('div', { class: 'od-brand' },
        el('img', { src: 'toolhound-logo.png', alt: 'ToolHound' })),
      title
    ]));

    // --- parties ----------------------------------------------------------
    var orderedBy = el('div', { class: 'od-party' }, [
      el('span', { class: 'od-lab od-blk', text: 'Ordered by' }),
      el('div', { class: 'od-nm', text: by.name || 'ToolHound, Inc.' })
    ]);
    var corr = el('div', { class: 'od-att od-att-flush' },
      el('b', { text: 'All correspondence' }));
    [by.salesEmail, by.accountingEmail, by.phone].filter(Boolean)
      .forEach(function (line) {
        corr.appendChild(el('div', { class: 'od-ln', text: line }));
      });
    orderedBy.appendChild(corr);

    var supplier = el('div', { class: 'od-party' }, [
      el('span', { class: 'od-lab od-blk', text: 'Supplier' }),
      el('div', { class: 'od-nm', text: sup.name || '' })
    ]);
    (sup.addressLines || []).forEach(function (line) {
      supplier.appendChild(el('div', { class: 'od-ln', text: line }));
    });

    var shipTo = el('div', { class: 'od-party od-shipto' }, [
      el('span', { class: 'od-lab od-blk',
        text: 'Ship to — deliver direct to end customer' }),
      el('div', { class: 'od-nm', text: txt(o.companyName) })
    ]);
    addressLines(o).forEach(function (line) {
      shipTo.appendChild(el('div', { class: 'od-ln', text: line }));
    });
    if (o.attentionName || o.shipToPhone) {
      var att = el('div', { class: 'od-att' });
      if (o.attentionName) {
        att.appendChild(el('b', { text: 'Attention: ' + txt(o.attentionName) }));
      }
      if (o.shipToPhone) {
        att.appendChild(el('div', { class: 'od-ln', text: txt(o.shipToPhone) }));
      }
      shipTo.appendChild(att);
    }

    doc.appendChild(el('div', { class: 'od-parties' }, [orderedBy, supplier, shipTo]));

    // --- reference strip --------------------------------------------------
    doc.appendChild(el('div', { class: 'od-refs' }, [
      el('div', { class: 'od-ref' }, [
        el('span', { class: 'od-lab od-blk',
          text: 'Our reference — quote this on all documents' }),
        el('span', { class: 'od-rv', text: ref || '—' })
      ]),
      el('div', { class: 'od-ref' }, [
        el('span', { class: 'od-lab od-blk', text: 'End customer' }),
        el('span', { class: 'od-rv', text: txt(o.companyName) || '—' })
      ])
    ]));

    // --- specification ----------------------------------------------------
    doc.appendChild(sectionBar('Label specification'));
    var specHead = el('tr', {}, [
      el('th', { class: 'od-narrow', text: '#' }),
      el('th', { text: 'Material and construction' }),
      el('th', { text: 'Die size' }),
      el('th', { text: 'Colours' }),
      el('th', { text: 'Serialised' }),
      el('th', { class: 'od-right', text: 'Quantity' })
    ]);
    var seq = splitSequence(o.seqStart, o.quantity);
    var specRow = el('tr', {}, [
      el('td', { class: 'od-m', text: '1' }),
      el('td', { class: 'od-b', text: stock }),
      el('td', { class: 'od-m', text: dieSize(o.labelWidthIn, o.labelHeightIn) || '—' }),
      el('td', { class: 'od-m', text: colourText(o.fullColor) }),
      el('td', { text: seq && seq.from ? 'Yes' : 'No' }),
      el('td', { class: 'od-m od-b od-right', text: groupThousands(o.quantity) })
    ]);
    doc.appendChild(el('table', { class: 'od-tbl' }, [
      el('thead', {}, specHead),
      el('tbody', {}, specRow)
    ]));

    // --- sequence ---------------------------------------------------------
    doc.appendChild(sectionBar('Sequence'));
    var seqHead = el('tr', {}, [
      el('th', { class: 'od-narrow', text: 'Seq' }),
      el('th', { text: 'Prefix' }),
      el('th', { text: 'From' }),
      el('th', { text: 'To' }),
      el('th', { text: 'Suffix' }),
      el('th', { class: 'od-right', text: 'Count' })
    ]);
    var seqRow = el('tr', {}, [
      el('td', { class: 'od-m', text: '1' }),
      el('td', { class: 'od-m', text: seq && seq.prefix ? seq.prefix : '—' }),
      el('td', { class: 'od-m od-b', text: seq && seq.from ? seq.from : '—' }),
      el('td', { class: 'od-m od-b', text: seq && seq.to ? seq.to : '—' }),
      el('td', { class: 'od-m', text: seq && seq.suffix ? seq.suffix : '—' }),
      el('td', { class: 'od-m od-right',
        text: seq && seq.count ? groupThousands(seq.count) : '—' })
    ]);
    doc.appendChild(el('table', { class: 'od-tbl' }, [
      el('thead', {}, seqHead),
      el('tbody', {}, seqRow)
    ]));

    // --- artwork and handling --------------------------------------------
    var artwork = el('div', { class: 'od-kv' });
    labelled('Artwork', LOGO_LABELS[o.logoChoice] || '')
      .forEach(function (n) { artwork.appendChild(n); });
    labelled('Logo file name (if applicable)',
      o.logoChoice === 'custom_logo' ? txt(o.logoFileName) : '')
      .forEach(function (n) { artwork.appendChild(n); });
    labelled('Printing', String(o.fullColor).toLowerCase() === 'yes'
      ? 'Full colour' : 'Black and white, single colour')
      .forEach(function (n) { artwork.appendChild(n); });
    labelled('Text on label', o.textLines && o.textLines.length
      ? o.textLines.join(' / ') : 'Logo only')
      .forEach(function (n) { artwork.appendChild(n); });

    var handling = el('div', { class: 'od-kv' });
    labelled('Proof', 'Required before production')
      .forEach(function (n) { handling.appendChild(n); });
    labelled('Proof to', by.salesEmail || '')
      .forEach(function (n) { handling.appendChild(n); });
    labelled('Invoice to', by.accountingEmail || '')
      .forEach(function (n) { handling.appendChild(n); });

    doc.appendChild(el('div', { class: 'od-two' }, [
      el('div', {}, artwork),
      el('div', {}, handling)
    ]));

    // --- instructions -----------------------------------------------------
    // The customer's own words first, then the standing reference line, so the
    // vendor sees one instruction block rather than hunting two places.
    var standing = 'Send a proof for customer approval before production, and quote '
      + 'our reference ' + (ref || '(see above)') + ' on the proof, order '
      + 'acknowledgement, packing slip and invoice.'
      + (by.salesEmail ? ' Send the proof to ' + by.salesEmail + '.' : '')
      + (by.accountingEmail ? ' Send the invoice to ' + by.accountingEmail + '.' : '');
    var instr = txt(o.instructions).trim();
    doc.appendChild(el('div', { class: 'od-block' }, [
      el('span', { class: 'od-lab od-blk', text: 'Instructions to supplier' }),
      el('div', { text: instr ? instr + ' ' + standing : standing })
    ]));

    // --- authorisation ----------------------------------------------------
    doc.appendChild(sectionBar('Customer authorisation'));
    var auth = el('div', { class: 'od-auth' }, [
      el('div', { class: 'od-authtext', text: cfg.authText || '' })
    ]);

    var sigCell = el('div', { class: 'od-sig' }, [
      el('span', { class: 'od-lab od-blk', text: 'Signature' })
    ]);
    if (o.signatureData) {
      sigCell.appendChild(el('img', { class: 'od-sigimg', src: o.signatureData,
        alt: 'Signature' }));
    }
    auth.appendChild(el('div', { class: 'od-siggrid' }, [
      sigCell,
      el('div', { class: 'od-sig' }, [
        el('span', { class: 'od-lab od-blk', text: 'Authorised by' }),
        el('span', { class: 'od-sigval', text: txt(o.authorizedName) })
      ]),
      el('div', { class: 'od-sig' }, [
        el('span', { class: 'od-lab od-blk', text: 'Date' }),
        el('span', { class: 'od-sigval od-m', text: fmtDate(o.approvalDate) })
      ])
    ]));
    doc.appendChild(auth);

    // --- footer -----------------------------------------------------------
    doc.appendChild(el('div', { class: 'od-foot' }, [
      el('span', { text: [by.name, by.salesEmail, by.accountingEmail, by.phone]
        .filter(Boolean).join(' · ') }),
      el('span', { class: 'od-m', text: ref })
    ]));

    return doc;
  }

  window.TOOLHOUND_ORDER_DOC = {
    render: render,
    fromForm: fromForm,
    fromRow: fromRow,
    // Exposed for the test suite, which checks the sequence split directly
    // rather than by reading it back out of the rendered table.
    splitSequence: splitSequence,
    dieSize: dieSize
  };
})();
