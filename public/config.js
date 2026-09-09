/**
 * Supabase connection settings for the public label order form.
 *
 * The publishable ("anon") key is designed to ship in client-side code — it is
 * visible to anyone who views source, and that is fine. What protects the data
 * is row level security on `public.label_orders`: the anon role holds an
 * INSERT-only policy and no SELECT policy, so this key can file an order but
 * cannot read anybody's order back. Never put the service_role key here.
 *
 * See supabase/migrations/ for the policies and constraints this relies on.
 */
window.TOOLHOUND_CONFIG = {
  supabaseUrl: 'https://ayqcteloqdrlemehozzk.supabase.co',
  supabaseAnonKey: 'sb_publishable_DpVxcMatuMmcyqF0B774AQ_y8EuFlp1',

  // Shown in the header and on the printed authorization record.
  supportPhone: '1 (800) 387-8665',

  // Shown on the confirmation screen and the printed authorization record.
  contact: {
    name: 'Graham Cooper',
    email: 'graham.cooper@toolhound.com',
    phone: '+1-847-386-1700',
    tollFree: '+1-800-387-8665',
    generalEmail: 'info@toolhound.com',
    supportEmail: 'support@toolhound.com',
    salesEmail: 'sales@toolhound.com',
    website: 'https://www.toolhound.com/'
  },

  // Who the order comes from, as it prints on the label order document.
  // No postal address by design: the customer's shipping address is the only
  // address on that sheet, so there is exactly one place to ship to and no
  // chance of a reader picking the wrong block.
  orderedBy: {
    name: 'ToolHound, Inc.',
    salesEmail: 'sales@toolhound.com',
    accountingEmail: 'accounting@toolhound.com',
    phone: '1 (800) 387-8665'
  },

  // The label supplier, as it prints on the same document.
  supplier: {
    name: 'Metalcraft, Inc.',
    addressLines: [
      '3360 9th Street SW',
      'Mason City, IA  50401',
      'United States'
    ]
  },

  // The label types ToolHound orders, and the sizes each one comes in.
  //
  // This used to be a single constant, on the assumption of one product. It
  // isn't one product. Every type and size below is one ToolHound has actually
  // invoiced between January 2022 and June 2026, taken from the Sales by
  // Customer Detail export, so this list is history rather than a guess.
  //
  // Size belongs to the type rather than sitting beside it, because the pairing
  // is the rule: 0.625" round and 1.50" x 0.50" are only cut on the anodized
  // aluminium, and 1.50" x 0.75" and 0.75" x 0.75" only on the poly pro.
  // Choosing the type narrows the sizes to the ones that exist, and the
  // database enforces the same pairing in case the form is ever bypassed.
  //
  // Deliberately not here, though all three have been invoiced: the plain
  // aluminium foil at 1.50" x 0.75" (Aecon Power Services, twice, whose
  // invoices never recorded a thickness), the Universal Micro RFID label at
  // 1 7/8" x 5/8" (Newgold, September 2024) and Bureau Veritas' bespoke 5 mil
  // matte PHA laminate (April 2022). None of them can be specified from this
  // form without guessing at a gauge or a construction, which is a
  // conversation with Metalcraft rather than a form field. A 1.00" x 1.00"
  // orange poly label (NWT FMD, March 2024) is also a one-off, but it is a
  // stocked size on a stocked material, so it stays.
  //
  // UNRESOLVED, and worth resolving: `.002" White Polypropylene` and `.002"
  // Premium Poly Pro` are both .002" polypropylene and both offered at
  // 1.25" x 0.50". They are almost certainly the same physical stock under two
  // names on Metalcraft's paperwork, in which case identical orders will split
  // across two type values and the cost-over-time and COGS work later has to
  // reconcile them. Both are here because Ian asked for both; if Metalcraft
  // confirm they are one stock, merge them and keep the name Metalcraft use.
  //
  // `docName` is the wording that prints on the document Metalcraft works from,
  // so it is theirs, not ours. `label` is what the customer picks from.
  // `allowsText: false` marks a size with no room for a line of text, which
  // takes the Custom Text artwork option off the table for that size.
  // `shape: 'round'` marks a circular die, which is specified by diameter --
  // stating a round label as width x height would have the printer reading the
  // bounding box as the die.
  labelTypes: [
    {
      value: 'premium_poly_pro',
      label: '.002" Premium Poly Pro',
      docName: '.002" Premium Poly Pro barcode label',
      sizes: [
        // Ordered by how often they have actually been bought.
        { value: '1.50x0.75', label: '1.50" x 0.75"', w: '1.50', h: '0.75' },
        { value: '1.25x0.50', label: '1.25" x 0.50"', w: '1.25', h: '0.50' },
        { value: '0.75x0.75', label: '0.75" x 0.75"', w: '0.75', h: '0.75' },
        { value: '1.00x1.00', label: '1.00" x 1.00"', w: '1.00', h: '1.00' }
      ]
    },
    {
      value: 'white_polypropylene',
      label: '.002" White Polypropylene',
      docName: '.002" white polypropylene label',
      // Only the one size has been seen on Metalcraft paperwork under this
      // name. See the note above about the overlap with Premium Poly Pro.
      sizes: [
        { value: '1.25x0.50', label: '1.25" x 0.50"', w: '1.25', h: '0.50' }
      ]
    },
    {
      value: 'anodized_aluminum_3mil',
      label: '.003" Anodized Aluminum Foil',
      // No finish in the name. Matte is what Metalcraft have supplied and what
      // their own paperwork says, but it is a finish rather than a stock, so it
      // goes in the special instructions when a customer asks for it. Baking it
      // into the type would have every order silently specifying it.
      docName: '.003" anodized aluminum foil label',
      sizes: [
        { value: '1.25x0.50', label: '1.25" x 0.50"', w: '1.25', h: '0.50' },
        { value: '1.50x0.50', label: '1.50" x 0.50"', w: '1.50', h: '0.50' },
        // The circular die. Invoiced as 0.625" Round, so that is what it says.
        // 0.625" across leaves no room for a line of text next to the code, so
        // this size takes artwork only. `allowsText: false` is read by the form
        // and mirrored by a check constraint, because a text-only round label
        // is an order Metalcraft cannot make.
        { value: '0.625round', label: '0.625" Round', w: '0.625', h: '0.625',
          shape: 'round', allowsText: false }
      ]
    }
  ],

  // The adhesive stated on the label order document.
  //
  // Blank on purpose, so the document shows a dash rather than a guess. The
  // form does not ask for it and the two orders that recorded one disagree:
  // Millstone Weber's PO says "pressure sensitive acrylic adhesive", Bureau
  // Veritas' says "MC778 3.5 mil kraft liner". Set this once Metalcraft
  // confirm the standard, or it becomes a form field if it varies per order.
  defaultAdhesive: '',

  // Wording for an order placed before label type was a field. Every such row
  // is poly pro, because that was the only stock the form could express.
  labelStock: '.002" Premium Poly Pro barcode label',

  // The authorization statement the customer agrees to. It lives here because
  // both the form and the internal dashboard render it -- the form to collect
  // the agreement, the dashboard to reproduce the signed record -- and two
  // copies of a legal sentence is two copies that can drift apart.
  authText:
    'I confirm that I have reviewed the label specifications provided above and '
    + 'that they are accurate. I authorize ToolHound to submit this custom label '
    + 'order for production based on these specifications. I understand that these '
    + 'labels are custom manufactured and cannot be returned once the approved '
    + 'order has been submitted for production.',

  // Largest artwork file a customer may attach, in megabytes. The database
  // caps the encoded payload at 6,000,000 characters, which is roughly 4.2MB
  // of binary — keep this at or below that.
  maxLogoFileMb: 4
};
