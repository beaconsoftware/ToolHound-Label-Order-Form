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
    custom_text: 'Text only',
    // Stated as an instruction rather than an absence, because "none" on a
    // vendor sheet reads as an omission somebody should chase.
    serial_only: 'Serial number only — no logo, no text'
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

  /**
   * Metalcraft state their die sizes to four decimals. Match them.
   *
   * A round die is specified by diameter. Stating 0.625" Round as
   * 0.6250 × 0.6250 in gives the printer the bounding box and calls it the
   * die, so `shape` is passed through from config and changes the wording.
   */
  function dieSize(widthIn, heightIn, shape) {
    var w = parseFloat(widthIn);
    var h = parseFloat(heightIn);
    if (!isFinite(w) || !isFinite(h)) return '';
    if (shape === 'round') return w.toFixed(4) + ' in dia.';
    return w.toFixed(4) + ' × ' + h.toFixed(4) + ' in';
  }

  /**
   * The shape of the die this order's type and size describe. Config is the
   * only place that knows a size is round, and it is matched on the numbers
   * rather than a stored flag so that an order written before `shape` existed
   * still resolves.
   */
  function shapeOf(cfg, labelType, widthIn, heightIn) {
    var types = cfg.labelTypes || [];
    var w = parseFloat(widthIn);
    var h = parseFloat(heightIn);
    for (var i = 0; i < types.length; i++) {
      if (types[i].value !== labelType) continue;
      var sizes = types[i].sizes || [];
      for (var j = 0; j < sizes.length; j++) {
        if (parseFloat(sizes[j].w) === w && parseFloat(sizes[j].h) === h) {
          return sizes[j].shape || 'rect';
        }
      }
    }
    return 'rect';
  }

  function groupThousands(n) {
    var v = parseInt(String(n == null ? '' : n).trim(), 10);
    if (!isFinite(v)) return txt(n);
    return v.toLocaleString('en-CA');
  }

  function artworkText(logoChoice) {
    return LOGO_LABELS[logoChoice] || txt(logoChoice) || '—';
  }

  /**
   * What the supplier is told to do. The customer's own words first, then the
   * standing reference line, so the vendor reads one instruction block rather
   * than hunting two places.
   *
   * Shared by the printed document and the email flavour. When these were two
   * copies of the same paragraph, an email could tell Metalcraft one thing
   * while the sheet attached to it said another.
   */
  function supplierInstructions(o, ref, opts) {
    var instr = txt(o.instructions).trim();
    // The vendor copy carries the customer's own words only. Everything the
    // standing paragraph says -- proofs, where to send the invoice, quoting our
    // reference -- is ToolHound's internal process and is handled off the
    // sheet. What it must never drop is the customer's instructions: "18x rolls
    // of 500" and "pressure sensitive acrylic adhesive" are how the labels get
    // made, not how the paperwork moves.
    if (opts && opts.audience === 'vendor') return instr;

    var by = (window.TOOLHOUND_CONFIG || {}).orderedBy || {};
    var standing = 'Send a proof for customer approval before production, and quote '
      + 'our reference ' + (ref || '(see above)') + ' on the proof, order '
      + 'acknowledgement, packing slip and invoice.'
      + (by.salesEmail ? ' Send the proof to ' + by.salesEmail + '.' : '')
      + (by.accountingEmail ? ' Send the invoice to ' + by.accountingEmail + '.' : '');
    return instr ? instr + ' ' + standing : standing;
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
      adhesive: d.adhesive,
      labelType: d.labelType,
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
      adhesive: row.adhesive,
      labelType: row.label_type,
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

  /** Supplier-facing wording for a label type value. */
  function materialText(cfg, labelType) {
    var types = cfg.labelTypes || [];
    for (var i = 0; i < types.length; i++) {
      if (types[i].value === labelType) {
        return types[i].docName || types[i].label;
      }
    }
    return cfg.labelStock || '';
  }

  /**
   * Build the document. `o` is the normalised shape above; use fromForm or
   * fromRow to produce it.
   */
  function render(o, opts) {
    opts = opts || {};
    // Two audiences, one template.
    //
    // 'vendor' is the sheet that goes to Metalcraft: the specification and
    // nothing else. Proof routing, invoice routing and the customer's signed
    // authorisation are ToolHound's business, and putting them in front of the
    // supplier invites them to act on process that is not theirs.
    //
    // 'record' (the default) is the signed copy: what the customer approved,
    // reproduced whole. Dropping the authorisation from that one would throw
    // away the only evidence that a nonreturnable order was agreed to.
    var vendor = opts.audience === 'vendor';
    var cfg = (window.TOOLHOUND_CONFIG || {});
    var by = cfg.orderedBy || {};
    var sup = cfg.supplier || {};
    // The material is whatever type the order carries. Rows written before
    // label type was a field have none, and every one of those is poly pro
    // because that was the only stock the form could express; cfg.labelStock
    // is that wording and nothing else.
    var stock = materialText(cfg, o.labelType);

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
    // The end customer was the ship-to company restated, so it said nothing the
    // panel above did not already say twice as loudly.
    doc.appendChild(el('div', { class: 'od-refs' }, [
      el('div', { class: 'od-ref' }, [
        el('span', { class: 'od-lab od-blk',
          text: 'Our reference — quote this on all documents' }),
        el('span', { class: 'od-rv', text: ref || '—' })
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
      el('th', { text: 'Quantity' })
    ]);
    var seq = splitSequence(o.seqStart, o.quantity);
    var specRow = el('tr', {}, [
      el('td', { class: 'od-m', text: '1' }),
      el('td', { class: 'od-b', text: stock }),
      el('td', { class: 'od-m', text: dieSize(o.labelWidthIn, o.labelHeightIn,
        shapeOf(cfg, o.labelType, o.labelWidthIn, o.labelHeightIn)) || '—' }),
      el('td', { class: 'od-m', text: colourText(o.fullColor) }),
      el('td', { text: seq && seq.from ? 'Yes' : 'No' }),
      el('td', { class: 'od-m od-b', text: groupThousands(o.quantity) })
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
      el('th', { text: 'Count' })
    ]);
    var seqRow = el('tr', {}, [
      el('td', { class: 'od-m', text: '1' }),
      el('td', { class: 'od-m', text: seq && seq.prefix ? seq.prefix : '—' }),
      el('td', { class: 'od-m od-b', text: seq && seq.from ? seq.from : '—' }),
      el('td', { class: 'od-m od-b', text: seq && seq.to ? seq.to : '—' }),
      el('td', { class: 'od-m', text: seq && seq.suffix ? seq.suffix : '—' }),
      el('td', { class: 'od-m',
        text: seq && seq.count ? groupThousands(seq.count) : '—' })
    ]);
    doc.appendChild(el('table', { class: 'od-tbl' }, [
      el('thead', {}, seqHead),
      el('tbody', {}, seqRow)
    ]));

    // --- artwork and handling --------------------------------------------
    var artwork = el('div', { class: 'od-kv' });
    labelled('Artwork', artworkText(o.logoChoice))
      .forEach(function (n) { artwork.appendChild(n); });
    // Adhesive is not asked for on the form, so it comes from config and is
    // deliberately blank until someone sets it. It is NOT defaulted to a
    // guess: the two orders that recorded one recorded different answers
    // (Millstone "pressure sensitive acrylic", Bureau Veritas "MC778 3.5 mil
    // kraft liner"), so a hardcoded value would be a spec asserted to the
    // printer on every order with nothing behind it.
    labelled('Adhesive', txt(o.adhesive) || txt(cfg.defaultAdhesive))
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

    if (vendor) {
      // Artwork alone, so it takes the full width rather than leaving the
      // right half of the panel empty.
      doc.appendChild(el('div', { class: 'od-two od-two-one' }, [
        el('div', {}, artwork)
      ]));
    } else {
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
    }

    // --- instructions -----------------------------------------------------
    // On the vendor copy this block appears only when the customer actually
    // wrote something, so an order with no notes gets no empty heading.
    var instrText = supplierInstructions(o, ref, opts);
    if (instrText) {
      doc.appendChild(el('div', { class: 'od-block' }, [
        el('span', { class: 'od-lab od-blk',
          text: vendor ? 'Special instructions' : 'Instructions to supplier' }),
        el('div', { text: instrText })
      ]));
    }

    if (vendor) {
      doc.appendChild(footer(by, ref));
      return doc;
    }

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
    doc.appendChild(footer(by, ref));

    return doc;
  }

  /** Shared, because the vendor copy returns before reaching the end. */
  function footer(by, ref) {
    return el('div', { class: 'od-foot' }, [
      el('span', { text: [by.name, by.salesEmail, by.accountingEmail, by.phone]
        .filter(Boolean).join(' · ') }),
      el('span', { class: 'od-m', text: ref })
    ]);
  }

  // ---------------------------------------------------------------------------
  // Email flavour
  //
  // The same order, serialised for pasting into Outlook or Gmail. It cannot be
  // the print markup: that is CSS grid with classes in a stylesheet, and every
  // mail client throws the stylesheet away and most mangle grid. So this is
  // tables with a style attribute on every cell, which is the one layout
  // technique mail clients have always agreed on.
  //
  // It is built from the same normalised order object and the same helpers as
  // render(), so the material wording, the die size and the sequence split
  // cannot say one thing on the printed sheet and another in the email.
  // ---------------------------------------------------------------------------

  var EM = {
    body: 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#201B1A;',
    lab: 'font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;'
       + 'letter-spacing:.06em;text-transform:uppercase;color:#5B5352;',
    labGap: 'padding-bottom:3px;',
    cell: 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#201B1A;'
        + 'padding:7px 9px;border:1px solid #C8BFBB;vertical-align:top;',
    th: 'font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;'
      + 'letter-spacing:.06em;text-transform:uppercase;color:#5B5352;'
      + 'text-align:left;padding:6px 9px;border:1px solid #C8BFBB;'
      + 'background:#F4F1EF;',
    sec: 'font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;'
       + 'letter-spacing:.1em;text-transform:uppercase;color:#ffffff;'
       + 'background:#201B1A;padding:5px 9px;'
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** A label over a value, as one table cell. */
  function emCell(label, lines, extra) {
    var html = '<td style="' + EM.cell + (extra || '') + '">'
      + '<div style="' + EM.lab + EM.labGap + '">' + esc(label) + '</div>';
    (Array.isArray(lines) ? lines : [lines]).forEach(function (l) {
      if (l === null || l === undefined || l === '') return;
      html += '<div>' + esc(l) + '</div>';
    });
    return html + '</td>';
  }

  function emRow(label, value) {
    return '<tr><td style="' + EM.cell + 'width:150px;background:#FAF7F4;">'
      + '<div style="' + EM.lab + '">' + esc(label) + '</div></td>'
      + '<td style="' + EM.cell + '"><strong>' + esc(value || '—')
      + '</strong></td></tr>';
  }

  function emSection(title) {
    return '<tr><td colspan="2" style="' + EM.sec + '">' + esc(title) + '</td></tr>';
  }

  /**
   * `opts.logoUrl` is an absolute URL for the ToolHound mark; a relative one is
   * meaningless once the HTML has left the page. `opts.artwork` is the
   * customer's file as { name, dataUrl } when it is a raster the client can
   * show inline, or { name } alone when it has to be attached instead.
   */
  function emailHtml(o, opts) {
    opts = opts || {};
    var cfg = (window.TOOLHOUND_CONFIG || {});
    var by = cfg.orderedBy || {};
    var sup = cfg.supplier || {};
    var ref = txt(o.quoteNumber).trim() || txt(o.orderRef).trim();
    var seq = splitSequence(o.seqStart, o.quantity);
    var shape = shapeOf(cfg, o.labelType, o.labelWidthIn, o.labelHeightIn);

    var h = '<div style="' + EM.body + 'max-width:760px;">';

    // masthead
    h += '<table cellpadding="0" cellspacing="0" border="0" width="100%"'
      + ' style="border-collapse:collapse;margin-bottom:12px;"><tr>'
      + '<td style="vertical-align:middle;">';
    if (opts.logoUrl) {
      h += '<img src="' + esc(opts.logoUrl) + '" alt="ToolHound" height="40"'
        + ' style="height:40px;width:auto;display:block;border:0;">';
    } else {
      h += '<strong style="font-size:17px;">ToolHound</strong>';
    }
    h += '</td><td style="text-align:right;vertical-align:middle;">'
      + '<div style="font-size:17px;font-weight:bold;letter-spacing:.03em;">'
      + 'LABEL ORDER</div>'
      + '<div style="font-size:12px;color:#5B5352;">Quote no. <strong'
      + ' style="color:#201B1A;">' + esc(ref || '—') + '</strong></div>'
      + '<div style="font-size:12px;color:#5B5352;">Issued '
      + esc(fmtDate(o.issuedAt)) + '</div>'
      + '</td></tr></table>';

    h += '<table cellpadding="0" cellspacing="0" border="0" width="100%"'
      + ' style="border-collapse:collapse;">';

    // parties
    h += '<tr>'
      + emCell('Ship to — deliver direct to end customer', [
          txt(o.companyName),
          txt(o.address),
          [txt(o.city), txt(o.stateProvince), txt(o.postalCode)]
            .filter(Boolean).join(', '),
          txt(o.country),
          o.attentionName ? 'Attention: ' + txt(o.attentionName) : '',
          txt(o.shipToPhone)
        ], 'background:#FBEDEC;')
      + emCell('Supplier', [txt(sup.name)].concat(sup.addressLines || []))
      + '</tr>';
    h += '<tr>'
      + emCell('Ordered by', [txt(by.name), txt(by.salesEmail),
          txt(by.accountingEmail), txt(by.phone)])
      + emCell('Our reference — quote this on all documents', [ref || '—'])
      + '</tr>';

    // specification
    h += emSection('Label specification');
    h += emRow('Material', materialText(cfg, o.labelType));
    h += emRow('Die size', dieSize(o.labelWidthIn, o.labelHeightIn, shape));
    h += emRow('Colours', colourText(o.fullColor));
    h += emRow('Quantity', groupThousands(o.quantity));

    // sequence
    h += emSection('Sequence');
    if (seq && seq.from) {
      h += emRow('Numbers', txt(o.seqStart).trim() + ' through '
        + seq.prefix + seq.to + seq.suffix);
      h += emRow('Count', groupThousands(seq.count));
    } else {
      h += emRow('Numbers', 'Not serialised');
    }

    // artwork
    h += emSection('Artwork');
    h += emRow('Type', artworkText(o.logoChoice));
    var adhesive = txt(o.adhesive) || txt(cfg.defaultAdhesive);
    if (adhesive) h += emRow('Adhesive', adhesive);
    if (o.logoChoice === 'custom_text') {
      h += emRow('Text on label', (o.textLines || []).join('  /  '));
    }
    if (o.logoFileName) h += emRow('Logo file name', o.logoFileName);

    // instructions -- called out on its own because it is the part a person
    // wrote, and the part most likely to be the reason for the email. The
    // email goes to Metalcraft, so it is the vendor copy unless told otherwise:
    // the customer's notes, without ToolHound's proof and invoice routing.
    var instrText = supplierInstructions(o, ref,
      { audience: opts.audience || 'vendor' });
    if (instrText) {
      h += emSection('Special instructions');
      h += '<tr><td colspan="2" style="' + EM.cell + '">'
        + esc(instrText).replace(/\n/g, '<br>')
        + '</td></tr>';
    }

    h += '</table>';

    if (opts.artwork && opts.artwork.dataUrl) {
      h += '<div style="' + EM.body + 'margin-top:14px;">'
        + '<div style="' + EM.lab + EM.labGap + '">Customer artwork — '
        + esc(opts.artwork.name || 'attached') + '</div>'
        + '<img src="' + esc(opts.artwork.dataUrl) + '" alt="Customer artwork"'
        + ' style="max-width:300px;height:auto;border:1px solid #C8BFBB;">'
        + '</div>';
    } else if (opts.artwork && opts.artwork.name) {
      h += '<div style="' + EM.body + 'margin-top:14px;color:#5B5352;">'
        + '<strong>Artwork:</strong> ' + esc(opts.artwork.name)
        + ' — attached to this email.</div>';
    }

    h += '<div style="' + EM.body + 'margin-top:14px;font-size:11px;'
      + 'color:#8C8280;border-top:1px solid #D9D3D0;padding-top:8px;">'
      + esc(txt(by.name)) + ' · ' + esc(txt(by.salesEmail)) + ' · '
      + esc(txt(by.accountingEmail)) + ' · ' + esc(txt(by.phone))
      + '</div>';

    return h + '</div>';
  }

  /**
   * The plain-text flavour. Written to the clipboard alongside the HTML so a
   * plain-text composer, or a paste into a terminal or a ticket, still gets
   * something readable rather than a wall of tags.
   */
  function emailText(o, opts) {
    opts = opts || {};
    var cfg = (window.TOOLHOUND_CONFIG || {});
    var by = cfg.orderedBy || {};
    var sup = cfg.supplier || {};
    var ref = txt(o.quoteNumber).trim() || txt(o.orderRef).trim();
    var seq = splitSequence(o.seqStart, o.quantity);
    var shape = shapeOf(cfg, o.labelType, o.labelWidthIn, o.labelHeightIn);
    var L = [];

    L.push('LABEL ORDER');
    L.push('Quote no.: ' + (ref || '-'));
    L.push('Issued: ' + fmtDate(o.issuedAt));
    L.push('');
    L.push('SHIP TO - DELIVER DIRECT TO END CUSTOMER');
    L.push('  ' + txt(o.companyName));
    L.push('  ' + txt(o.address));
    L.push('  ' + [txt(o.city), txt(o.stateProvince), txt(o.postalCode)]
      .filter(Boolean).join(', '));
    L.push('  ' + txt(o.country));
    if (o.attentionName) L.push('  Attention: ' + txt(o.attentionName));
    if (o.shipToPhone) L.push('  ' + txt(o.shipToPhone));
    L.push('');
    L.push('SUPPLIER');
    L.push('  ' + txt(sup.name));
    (sup.addressLines || []).forEach(function (l) { L.push('  ' + l); });
    L.push('');
    L.push('LABEL SPECIFICATION');
    L.push('  Material:  ' + materialText(cfg, o.labelType));
    L.push('  Die size:  ' + dieSize(o.labelWidthIn, o.labelHeightIn, shape));
    L.push('  Colours:   ' + colourText(o.fullColor));
    L.push('  Quantity:  ' + groupThousands(o.quantity));
    L.push('');
    L.push('SEQUENCE');
    if (seq && seq.from) {
      L.push('  ' + txt(o.seqStart).trim() + ' through '
        + seq.prefix + seq.to + seq.suffix
        + '  (' + groupThousands(seq.count) + ' labels)');
    } else {
      L.push('  Not serialised');
    }
    L.push('');
    L.push('ARTWORK');
    L.push('  Type: ' + artworkText(o.logoChoice));
    var adhesive = txt(o.adhesive) || txt(cfg.defaultAdhesive);
    if (adhesive) L.push('  Adhesive: ' + adhesive);
    if (o.logoChoice === 'custom_text') {
      L.push('  Text on label: ' + (o.textLines || []).join('  /  '));
    }
    if (o.logoFileName) L.push('  Logo file name: ' + o.logoFileName);
    if (opts.artwork && opts.artwork.name) {
      L.push('  Artwork file: ' + opts.artwork.name
        + (opts.artwork.dataUrl ? ' (shown above)' : ' (attached)'));
    }
    L.push('');
    var instrText = supplierInstructions(o, ref,
      { audience: opts.audience || 'vendor' });
    if (instrText) {
      L.push('SPECIAL INSTRUCTIONS');
      instrText.split('\n').forEach(function (l) { L.push('  ' + l); });
      L.push('');
    }
    L.push(txt(by.name) + ' · ' + txt(by.salesEmail) + ' · '
      + txt(by.accountingEmail) + ' · ' + txt(by.phone));

    return L.join('\n');
  }

  window.TOOLHOUND_ORDER_DOC = {
    render: render,
    fromForm: fromForm,
    fromRow: fromRow,
    emailHtml: emailHtml,
    emailText: emailText,
    // Exposed for the test suite, which checks the sequence split directly
    // rather than by reading it back out of the rendered table.
    splitSequence: splitSequence,
    dieSize: dieSize
  };
})();
