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
  // This used to be a single constant, on the assumption of one product. The
  // anodized aluminium circular label ended that: NWT order round aluminium
  // labels, and 0.625" x 0.625" is not a size the poly pro stock is cut to.
  //
  // Size belongs to the type rather than sitting beside it, because the pairing
  // is the rule. A circular label has exactly one size, so the form states it
  // rather than offering a choice, and the database enforces the same pairing
  // in case the form is ever bypassed.
  //
  // `docName` is the wording that prints on the document Metalcraft works from,
  // so it is theirs, not ours. `label` is what the customer picks from.
  labelTypes: [
    {
      value: 'premium_poly_pro',
      label: '.002" Premium Poly Pro',
      docName: '.002" Premium Poly Pro barcode label',
      sizes: [
        { value: '1.50x0.75', label: '1.50" x 0.75"', w: '1.50', h: '0.75' },
        { value: '1.25x0.50', label: '1.25" x 0.50"', w: '1.25', h: '0.50' }
      ]
    },
    {
      value: 'anodized_aluminum_circular',
      label: '.003" Matte Anodized Aluminum Circular',
      docName: '.003" Matte Anodized Aluminum Circular label',
      // One size, stated rather than chosen. Written the way Metalcraft write
      // it on their own sheet: a circular die, expressed as a square.
      sizes: [
        { value: '0.625x0.625', label: '0.625" x 0.625"', w: '0.625', h: '0.625' }
      ]
    }
  ],

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
