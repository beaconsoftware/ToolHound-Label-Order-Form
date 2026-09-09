const { test, expect } = require('@playwright/test');

/**
 * End-to-end tests for the label order wizard.
 *
 * Every test stubs the database client before page scripts run, so the suite is
 * hermetic: no network, no Supabase credentials, and no rows written to a real
 * project. `window.__TOOLHOUND_DB__` is the seam app.js checks first.
 */

/** Install a stub client and capture whatever the form tries to insert. */
async function stubDb(page, { failWith = null, failFirstNTimes = 0 } = {}) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());

  await page.addInitScript(
    ({ failWith, failFirstNTimes }) => {
      window.__INSERTED__ = [];
      let calls = 0;
      window.__TOOLHOUND_DB__ = {
        from() {
          return {
            insert(row) {
              calls++;
              window.__INSERTED__.push(row);
              if (failWith && calls <= (failFirstNTimes || Number.MAX_SAFE_INTEGER)) {
                return Promise.resolve({ error: failWith });
              }
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    },
    { failWith, failFirstNTimes }
  );
}

async function fillStep1(page, overrides = {}) {
  const v = {
    quote: 'GC-24-175A',
    company: 'Acme Industrial',
    contact: 'Dana Reyes',
    email: 'dana@acme.example',
    address: '400 Foundry Rd',
    city: 'Hamilton',
    region: 'ON',
    postal: 'L8E 2W1',
    country: 'Canada',
    ...overrides
  };
  await page.getByLabel('ToolHound Quote Number *').fill(v.quote);
  await page.getByLabel('Company Name *').fill(v.company);
  await page.getByLabel('Customer Contact Name *').fill(v.contact);
  await page.getByLabel('Customer Contact Email *').fill(v.email);
  await page.getByLabel('Shipping Address *').fill(v.address);
  await page.getByLabel('City *').fill(v.city);
  await page.getByLabel('State / Province *').fill(v.region);
  await page.getByLabel('Postal / ZIP Code *').fill(v.postal);
  await page.getByLabel('Country *').fill(v.country);
}

const QUANTITY_OPTIONS = [500, 1000, 1500, 2000, 2500, 5000, 7500, 10000];

/** Pick the quantity dropdown option when it's a standard increment, else fall
 *  back to the "Other" free-entry input. */
async function fillQuantity(page, quantity) {
  const n = Number(quantity);
  if (QUANTITY_OPTIONS.includes(n)) {
    await page.getByLabel('Quantity *').selectOption(String(n));
  } else {
    await page.getByLabel('Quantity *').selectOption('other');
    await page.getByLabel('Exact quantity').fill(String(quantity));
  }
}

async function fillStep2(page, { quantity = '500', seqStart = '1000' } = {}) {
  await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
  await page.getByRole('radio', { name: 'Yes', exact: true }).check();
  await fillQuantity(page, quantity);
  await page.getByLabel('Starting Label Number *').fill(seqStart);
  await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
  await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
}

/** Types a name into the signature field, which renders it to the canvas. */
async function signTyped(page, name = 'Dana Reyes') {
  await page.getByLabel('Type your name to sign').fill(name);
}

async function fillStep4(page, name = 'Dana Reyes') {
  await page.getByLabel('Authorized Name *').fill(name);
  await signTyped(page, name);
  await page.getByLabel('I have read and agree').check();
}

test.beforeEach(async ({ page }) => {
  await stubDb(page);
  await page.goto('/index.html');
});

/**
 * The document tests all need a submitted order on screen, and every one of
 * them would otherwise repeat the same four steps. `overrides` reaches whichever
 * step owns the field.
 */
async function gotoForm(page) {
  await page.goto('/index.html');
}

async function submitOrder(page, overrides = {}) {
  const { quantity = '500', seqStart = '1000',
          authorizedName = 'Dana Reyes', ...step1 } = overrides;
  await gotoForm(page);
  await fillStep1(page, step1);
  await page.getByRole('button', { name: 'Continue' }).click();
  await fillStep2(page, { quantity, seqStart });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue to Authorization' }).click();
  await fillStep4(page, authorizedName);
  await page.getByRole('button', { name: 'Submit Order' }).click();
  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
}

test('completes the full order flow and records the submission', async ({ page }) => {
  await fillStep1(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  await fillStep2(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Review Your Order' })).toBeVisible();
  await expect(page.getByText('Acme Industrial')).toBeVisible();
  // The review step spells out the computed range so an off-by-one is visible.
  await expect(page.getByText('1000 – 1499')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Authorization' }).click();

  await fillStep4(page);
  await page.getByRole('button', { name: 'Submit Order' }).click();

  await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
  await expect(page.locator('.success').getByText(/^Reference: THL-/)).toBeVisible();

  const rows = await page.evaluate(() => window.__INSERTED__);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    company_name: 'Acme Industrial',
    contact_email: 'dana@acme.example',
    logo_choice: 'toolhound_logo',
    full_color: 'Yes',
    quantity: 500,
    seq_start: '1000',
    authorized_name: 'Dana Reyes',
    logo_file_name: null,
    text_lines: null
  });
  // Quantity must reach the database as an integer, not a string, or the
  // integer column rejects it. The sequence is deliberately the opposite: it
  // goes as text, exactly as typed, so leading zeros survive.
  expect(typeof rows[0].quantity).toBe('number');
  expect(typeof rows[0].seq_start).toBe('string');
});

test.describe('step 1 validation', () => {
  test('blocks empty required fields', async ({ page }) => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Customer & Shipping Information' }))
      .toBeVisible();
    await expect(page.getByText('Required').first()).toBeVisible();
  });

  test('rejects a malformed email with a specific message', async ({ page }) => {
    await fillStep1(page, { email: 'dana-at-acme' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Customer & Shipping Information' }))
      .toBeVisible();
  });
});

test.describe('step 2 validation', () => {
  test.beforeEach(async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  // Regression: el() set attributes from null values, so every radio in a group
  // received checked="null" and rendered as selected regardless of state.
  test('no label choice is preselected, and selecting one checks exactly it',
    async ({ page }) => {
      const radios = page.getByRole('radio', { name: /Custom Logo|Custom Text|ToolHound Logo/ });
      await expect(radios).toHaveCount(3);
      for (const r of await radios.all()) {
        await expect(r).not.toBeChecked();
      }

      await page.getByRole('radio', { name: 'Custom Text' }).check();
      await expect(page.getByRole('radio', { name: 'Custom Text' })).toBeChecked();
      await expect(page.getByRole('radio', { name: 'Custom Logo' })).not.toBeChecked();
      await expect(page.getByRole('radio', { name: 'ToolHound Logo' })).not.toBeChecked();
    });

  test('requires a logo choice', async ({ page }) => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Please choose one').first()).toBeVisible();
  });

  // Regression: choosing "Custom Logo" without attaching artwork used to fail
  // silently — Continue did nothing and no message appeared.
  test('explains why a custom logo order cannot continue without a file',
    async ({ page }) => {
      await page.getByRole('radio', { name: 'Custom Logo' }).check();
      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
      await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
      await fillQuantity(page, '100');
      await page.getByLabel('Starting Label Number *').fill('1');
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Please upload a logo file')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Label Specifications' }))
        .toBeVisible();
    });

  // Regression: "Text Line 1 *" was marked required but never validated, so an
  // order could be placed with no text to print.
  test('requires at least one line of custom text', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await fillQuantity(page, '100');
    await page.getByLabel('Starting Label Number *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Enter at least one line of text')).toBeVisible();
  });

  // Custom text has no logo to colour, so the full-colour question — and the
  // surcharge it implies — should not appear for that choice.
  test('hides the full-colour question for custom text orders', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await expect(page.getByText('Should the logo be printed in full colour?')).toBeHidden();
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await expect(page.getByText('Should the logo be printed in full colour?')).toBeVisible();
  });

  // 18 characters, and the cap has to hold in the browser because the database
  // enforces the same number: a form that let a nineteenth character through
  // would fail the insert with a constraint error naming nothing useful.
  test('caps each custom text line at 18 characters', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    const line1 = page.getByLabel('Text line 1');
    await line1.fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(line1).toHaveValue('ABCDEFGHIJKLMNOPQR');
  });

  test('all three lines take the full 18 characters', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Text' }).check();
    const eighteen = 'NORTHGATE MINING B';
    for (const n of [1, 2, 3]) {
      const line = page.getByLabel('Text line ' + n);
      await line.fill(eighteen);
      await expect(line).toHaveValue(eighteen);
      // The counter is what tells the customer how much room is left, so it
      // has to agree with the cap rather than with the old one. It sits in the
      // row beside its own input; "Text line n" is an aria-label, not text, so
      // the row is located by position.
      await expect(page.locator('.textline-row').nth(n - 1)
        .locator('.char-count')).toHaveText('18/18');
    }
  });

  // Regression: `!d.quantity` is false for the string "0", so zero-quantity
  // orders passed validation and reached the database.
  test('rejects a quantity of zero', async ({ page }) => {
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '0');
    await page.getByLabel('Starting Label Number *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Quantity must be at least 1')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  // The label number is printed literally, so the field only accepts what can
  // appear on a tag. Hyphens are allowed for TSG-0001, which means a leading
  // minus survives the as-you-type filter and has to be caught at Continue.
  test('rejects a label number that does not start with a letter or digit',
    async ({ page }) => {
      await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await fillQuantity(page, '50');
      await page.getByLabel('Starting Label Number *').fill('-5');
      await page.getByRole('button', { name: 'Continue' }).click();

      // Scoped to the error: the field's own hint text uses the same wording.
      await expect(page.locator('.err-msg', {
        hasText: 'Letters, numbers and hyphens, up to 9 characters'
      })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Label Specifications' }))
        .toBeVisible();
    });

  // Without trailing digits there is nothing to count up from, so the end of
  // the run cannot be worked out at all.
  test('requires the label number to end in a digit', async ({ page }) => {
    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '50');
    await page.getByLabel('Starting Label Number *').fill('TSG-');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  // Leading zeros are the whole reason the sequence is stored as typed: the
  // signed acknowledgement form reads TSG-0001, and the vendor prints the
  // description literally, so TSG-1 would be the wrong label.
  test('keeps the padding when counting up to the end of the run',
    async ({ page }) => {
      await fillQuantity(page, '500');
      await page.getByLabel('Starting Label Number *').fill('TSG-0001');
      await expect(page.getByText('This order will print labels TSG-0001 through TSG-0500.'))
        .toBeVisible();
    });

  test('previews the resulting sequence range as the customer types',
    async ({ page }) => {
      await fillQuantity(page, '250');
      await page.getByLabel('Starting Label Number *').fill('500');
      await expect(page.getByText('This order will print labels 500 through 749.'))
        .toBeVisible();
    });

  test('rejects an unsupported artwork file type', async ({ page }) => {
    await page.getByRole('radio', { name: 'Custom Logo' }).check();
    await page.setInputFiles('input[type=file]', {
      name: 'spec.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('not artwork')
    });
    await expect(page.getByText(/file type is not supported/)).toBeVisible();
  });

  test('accepts a PNG logo and carries the filename through to the order',
    async ({ page }) => {
      // Smallest valid PNG.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      await page.getByRole('radio', { name: 'Custom Logo' }).check();
      await page.setInputFiles('input[type=file]', {
        name: 'acme-mark.png', mimeType: 'image/png', buffer: png
      });
      await expect(page.getByText('Selected: acme-mark.png')).toBeVisible();

      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
      await page.getByRole('radio', { name: '1.50" x 0.75"' }).check();
      await fillQuantity(page, '100');
      await page.getByLabel('Starting Label Number *').fill('1');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const rows = await page.evaluate(() => window.__INSERTED__);
      expect(rows[0].logo_file_name).toBe('acme-mark.png');
      // The database constraint only accepts recognised data URL prefixes.
      expect(rows[0].logo_file_data).toMatch(/^data:image\/png;base64,/);
    });
});

test.describe('custom text orders', () => {
  test('sends only the non-empty lines', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'Custom Text' }).check();
    await page.getByLabel('Text line 1').fill('ACME');
    await page.getByLabel('Text line 3').fill('YARD 4');
    await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
    await page.getByRole('radio', { name: '1.25" x 0.50"' }).check();
    await fillQuantity(page, '75');
    await page.getByLabel('Starting Label Number *').fill('0');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('ACME / YARD 4')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows[0].text_lines).toEqual(['ACME', 'YARD 4']);
    expect(rows[0].full_color).toBe('No');
  });
});

test.describe('step 4 authorization', () => {
  test.beforeEach(async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
  });

  test('requires the agreement checkbox', async ({ page }) => {
    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByText('Please check the box to continue')).toBeVisible();
    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows).toHaveLength(0);
  });

  test('requires an authorized name', async ({ page }) => {
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByLabel('Authorized Name *')).toHaveAttribute('aria-invalid', 'true');
    const rows = await page.evaluate(() => window.__INSERTED__);
    expect(rows).toHaveLength(0);
  });
});

test.describe('submission failures', () => {
  test('shows an inline error and lets the customer retry', async ({ page }) => {
    await stubDb(page, { failWith: { code: 'PGRST301', message: 'boom' } });
    await page.goto('/index.html');

    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByText(/Something went wrong submitting your order/))
      .toBeVisible();
    // Still on the authorization step, with the button usable again.
    await expect(page.getByRole('button', { name: 'Submit Order' })).toBeEnabled();
    // The entered details survive the failure.
    await expect(page.getByLabel('Authorized Name *')).toHaveValue('Dana Reyes');
  });

  test('explains a constraint rejection in terms the customer can act on',
    async ({ page }) => {
      await stubDb(page, { failWith: { code: '23514', message: 'check violation' } });
      await page.goto('/index.html');

      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByText(/rejected as invalid/)).toBeVisible();
    });

  // The order reference is generated in the browser, so a same-millisecond
  // collision is possible; the form should quietly try a new reference.
  test('retries with a fresh reference after a duplicate key error',
    async ({ page }) => {
      await stubDb(page, {
        failWith: { code: '23505', message: 'duplicate key' },
        failFirstNTimes: 1
      });
      await page.goto('/index.html');

      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
      const rows = await page.evaluate(() => window.__INSERTED__);
      expect(rows).toHaveLength(2);
      expect(rows[0].order_ref).not.toBe(rows[1].order_ref);
    });
});

test.describe('confirmation record', () => {
  test('renders a printable authorization with the specs and the reference',
    async ({ page }) => {
      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Print / save a copy' }))
        .toBeVisible();

      // The print block is hidden on screen but carries the full document.
      const print = page.locator('.print-only');
      await expect(print).toBeHidden();
      await expect(print).toContainText('Label Order');
      await expect(print).toContainText('Acme Industrial');
      await expect(print).toContainText('cannot be returned');
      await expect(print).toContainText('Dana Reyes');
      // The reference on the sheet is the quote number, not the internal ref.
      await expect(print).toContainText('GC-24-175A');
    });

  // The confirmation must not promise an email that nothing sends.
  test('does not claim a confirmation email was sent', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
    await expect(page.locator('.success')).not.toContainText(/confirmation will be sent/i);
  });
});

test.describe('order references', () => {
  test('are unique across many generations', async ({ page }) => {
    const refs = await page.evaluate(() => {
      const out = new Set();
      for (let i = 0; i < 5000; i++) out.add(window.__TOOLHOUND_FORM__.makeOrderRef());
      return out.size;
    });
    expect(refs).toBe(5000);
  });

  test('use an unambiguous alphabet', async ({ page }) => {
    const ref = await page.evaluate(() => window.__TOOLHOUND_FORM__.makeOrderRef());
    expect(ref).toMatch(/^THL-[0-9A-Z]+-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

test.describe('fields the vendor PO needs', () => {
  test('carries label size, label number, phone and receiving contact',
    async ({ page }) => {
      await fillStep1(page);
      await page.getByLabel('Receiving Contact').fill('Mike Betts');
      await page.getByLabel('Delivery Phone').fill('204-555-0117');
      await page.getByRole('button', { name: 'Continue' }).click();

      await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
      await page.getByRole('radio', { name: 'No', exact: true }).check();
      await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
      await page.getByRole('radio', { name: '1.25" x 0.50"' }).check();
      await fillQuantity(page, '3000');
      await page.getByLabel('Starting Label Number *').fill('vol6001');

      // What gets printed on the tag is what the customer sees while typing,
      // so it is upper-cased in the field rather than silently at submit time.
      await expect(page.getByLabel('Starting Label Number *')).toHaveValue('VOL6001');
      // Scoped to the preview: the field's own hint text also names VOL6001.
      await expect(page.locator('.seq-preview')).toContainText('VOL6001');
      await expect(page.locator('.seq-preview')).toContainText('VOL9000');

      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('1.25" x 0.50"').last()).toBeVisible();
      await expect(page.getByText('VOL6001 – VOL9000')).toBeVisible();

      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const row = (await page.evaluate(() => window.__INSERTED__))[0];
      expect(row.label_width_in).toBe(1.25);
      expect(row.label_height_in).toBe(0.5);
      expect(row.seq_start).toBe('VOL6001');
      expect(row.ship_to_phone).toBe('204-555-0117');
      expect(row.attention_name).toBe('Mike Betts');
    });

  // The form no longer asks the customer for their own PO number. The column
  // stays for orders that already carry one, so submissions send null.
  test('no longer asks the customer for their PO number', async ({ page }) => {
    await expect(page.getByLabel('Your PO Number')).toHaveCount(0);
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    expect(row.customer_po).toBeNull();
  });

  test('the optional fields stay null when left blank', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    // Null rather than empty string: the columns are nullable so "not asked"
    // stays distinguishable from "answered with nothing".
    expect(row.ship_to_phone).toBeNull();
    expect(row.attention_name).toBeNull();
    expect(row.customer_po).toBeNull();
  });

  test('will not continue without a label size', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Label Number *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Please choose a label size')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  test('will not continue without a label type', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Label Number *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Please choose a label type')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Label Specifications' })).toBeVisible();
  });

  // Only stocked sizes are offered, and only against the stock they belong to.
  // A free-text size was a way to reach production with something Metalcraft
  // does not carry; a size shown against the wrong stock is the same problem
  // wearing a dropdown. Every pairing below is one ToolHound has invoiced.
  test('offers only the sizes the chosen stock is made in', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    // No type chosen yet: nothing to pick from, and the form says why.
    await expect(page.getByRole('radio', { name: '1.50" x 0.75"' })).toHaveCount(0);
    await expect(page.getByText('Choose a label type first.')).toBeVisible();

    await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
    await expect(page.getByRole('radio', { name: 'Another size' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '1.50" x 0.75"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '1.25" x 0.50"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '0.75" x 0.75"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '1.00" x 1.00"' })).toHaveCount(1);
    // Poly pro is not cut on the aluminium dies.
    await expect(page.getByRole('radio', { name: '0.625" Round' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '1.50" x 0.50"' })).toHaveCount(0);

    await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
    await expect(page.getByRole('radio', { name: '1.25" x 0.50"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '1.50" x 0.50"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '0.625" Round' })).toHaveCount(1);
    // The poly-pro-only sizes are gone.
    await expect(page.getByRole('radio', { name: '1.50" x 0.75"' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '0.75" x 0.75"' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '1.00" x 1.00"' })).toHaveCount(0);

    await page.getByRole('radio', { name: '.002" White Polypropylene' }).check();
    await expect(page.getByRole('radio', { name: '1.25" x 0.50"' })).toHaveCount(1);
    await expect(page.getByRole('radio', { name: '0.625" Round' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '1.50" x 0.75"' })).toHaveCount(0);
  });

  test('submits the white polypropylene stock', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'No', exact: true }).check();
    await page.getByRole('radio', { name: '.002" White Polypropylene' }).check();
    await page.getByRole('radio', { name: '1.25" x 0.50"' }).check();
    await fillQuantity(page, '3000');
    await page.getByLabel('Starting Label Number *').fill('1000');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('.002" White Polypropylene').last()).toBeVisible();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    expect(row.label_type).toBe('white_polypropylene');
    expect(row.label_width_in).toBe(1.25);
    expect(row.label_height_in).toBe(0.5);

    await page.waitForSelector('.order-doc', { state: 'attached' });
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.order-doc'))
      .toContainText('.002" white polypropylene label');
  });

  // A label that carries the serial number and nothing else. The other three
  // options could not express it, which is how "NO TEXT" ended up being typed
  // in as the text on a real order.
  test.describe('serial number only', () => {
    test('asks no artwork or colour questions and submits bare',
      async ({ page }) => {
        await fillStep1(page);
        await page.getByRole('button', { name: 'Continue' }).click();

        await page.getByRole('radio', { name: 'Serial Number Only' }).check();
        // No logo to colour, so the question and its surcharge do not apply.
        await expect(page.getByText('Should the logo be printed in full colour?'))
          .toHaveCount(0);
        // And no artwork inputs.
        await expect(page.getByLabel('Text line 1')).toHaveCount(0);
        await expect(page.getByText('Upload customer logo file')).toHaveCount(0);

        await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
        await page.getByRole('radio', { name: '0.625" Round' }).check();
        await fillQuantity(page, '500');
        await page.getByLabel('Starting Label Number *').fill('NT017800');
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByRole('button', { name: 'Continue to Authorization' }).click();
        await fillStep4(page);
        await page.getByRole('button', { name: 'Submit Order' }).click();

        const row = (await page.evaluate(() => window.__INSERTED__))[0];
        expect(row.logo_choice).toBe('serial_only');
        expect(row.text_lines).toBeNull();
        expect(row.logo_file_name).toBeNull();
        // The column is required, and the implied answer is no surcharge.
        expect(row.full_color).toBe('No');
      });

    test('the vendor document says so rather than leaving artwork blank',
      async ({ page }) => {
        await fillStep1(page);
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByRole('radio', { name: 'Serial Number Only' }).check();
        await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
        await page.getByRole('radio', { name: '0.625" Round' }).check();
        await fillQuantity(page, '500');
        await page.getByLabel('Starting Label Number *').fill('NT017800');
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByRole('button', { name: 'Continue to Authorization' }).click();
        await fillStep4(page);
        await page.getByRole('button', { name: 'Submit Order' }).click();

        await page.waitForSelector('.order-doc', { state: 'attached' });
        await page.emulateMedia({ media: 'print' });
        const doc = page.locator('.order-doc');
        await expect(doc).toContainText('Serial number only');
        await expect(doc).toContainText('no logo, no text');
        await expect(doc).not.toContainText('NO TEXT');
      });

    // The reason this option exists: it is available on the die that has no
    // room for text, where Custom Text is not.
    test('is available on the round die, unlike custom text', async ({ page }) => {
      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();

      await page.getByRole('radio', { name: 'Serial Number Only' }).check();
      await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
      await expect(page.getByRole('radio', { name: '0.625" Round' })).toBeEnabled();

      await page.getByRole('radio', { name: 'Custom Text' }).check();
      await expect(page.getByRole('radio', { name: '0.625" Round' })).toBeDisabled();
    });
  });

  // 0.625" across leaves nowhere to put a line of text beside the code, so the
  // combination has to be unreachable rather than merely discouraged.
  test.describe('no text on the round die', () => {
    async function toStep2(page) {
      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
    }

    test('the round size is blocked while custom text is the artwork',
      async ({ page }) => {
        await toStep2(page);
        await page.getByRole('radio', { name: 'Custom Text' }).check();
        await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();

        const round = page.getByRole('radio', { name: '0.625" Round' });
        await expect(round).toBeDisabled();
        await expect(page.getByText('No room for text on this label')).toBeVisible();
        // The sizes that can carry text are unaffected.
        await expect(page.getByRole('radio', { name: '1.25" x 0.50"' })).toBeEnabled();
        await expect(page.getByRole('radio', { name: '1.50" x 0.50"' })).toBeEnabled();
      });

    test('choosing custom text drops a round size already selected',
      async ({ page }) => {
        await toStep2(page);
        // Round first, text second: the order a customer would actually hit it
        // in, since the artwork question sits above the size.
        await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
        await page.getByRole('radio', { name: 'No', exact: true }).check();
        await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
        await page.getByRole('radio', { name: '0.625" Round' }).check();
        await expect(page.getByRole('radio', { name: '0.625" Round' })).toBeChecked();

        await page.getByRole('radio', { name: 'Custom Text' }).check();
        await expect(page.getByRole('radio', { name: '0.625" Round' })).toBeDisabled();
        await expect(page.getByRole('radio', { name: '0.625" Round' })).not.toBeChecked();

        // And it cannot be continued past without picking a size that fits.
        await page.getByLabel('Text line 1').fill('ACME');
        await fillQuantity(page, '500');
        await page.getByLabel('Starting Label Number *').fill('1');
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByText('Please choose a label size')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Label Specifications' }))
          .toBeVisible();
      });

    test('a logo on the round die is still fine', async ({ page }) => {
      await toStep2(page);
      await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
      await page.getByRole('radio', { name: 'No', exact: true }).check();
      await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
      await page.getByRole('radio', { name: '0.625" Round' }).check();
      await fillQuantity(page, '500');
      await page.getByLabel('Starting Label Number *').fill('1');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const row = (await page.evaluate(() => window.__INSERTED__))[0];
      expect(row.label_type).toBe('anodized_aluminum_3mil');
      expect(row.label_width_in).toBe(0.625);
      expect(row.text_lines).toBeNull();
    });
  });

  // 0.625 is the reason label_width_in had to move off numeric(5,2). If it ever
  // arrives as 0.63 the vendor cuts to the wrong die, so the submitted row is
  // asserted exactly.
  test('submits the round anodized die at full precision', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
    await page.getByRole('radio', { name: '0.625" Round' }).check();
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Label Number *').fill('TSG-0001');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('.003" Anodized Aluminum Foil').last())
      .toBeVisible();
    await expect(page.getByText('0.625" Round').last()).toBeVisible();

    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    expect(row.label_type).toBe('anodized_aluminum_3mil');
    expect(row.label_width_in).toBe(0.625);
    expect(row.label_height_in).toBe(0.625);
  });

  // A round die is specified by diameter. Width x height would hand Metalcraft
  // the bounding box and call it the die.
  test('the vendor document states a round die as a diameter', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
    await page.getByRole('radio', { name: '0.625" Round' }).check();
    await fillQuantity(page, '500');
    await page.getByLabel('Starting Label Number *').fill('TSG-0001');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();

    await page.waitForSelector('.order-doc', { state: 'attached' });
    await page.emulateMedia({ media: 'print' });
    const doc = page.locator('.order-doc');
    await expect(doc).toContainText('0.6250 in dia.');
    await expect(doc).not.toContainText('0.6250 × 0.6250');
  });

  // A rectangular die on the same stock still reads as width x height, so the
  // diameter wording is the round size's own and not the material's.
  test('a rectangular anodized die still states both dimensions',
    async ({ page }) => {
      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();

      await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
      await page.getByRole('radio', { name: 'Yes', exact: true }).check();
      await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
      await page.getByRole('radio', { name: '1.50" x 0.50"' }).check();
      await fillQuantity(page, '500');
      await page.getByLabel('Starting Label Number *').fill('TSG-0001');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      const row = (await page.evaluate(() => window.__INSERTED__))[0];
      expect(row.label_type).toBe('anodized_aluminum_3mil');
      expect(row.label_width_in).toBe(1.5);
      expect(row.label_height_in).toBe(0.5);

      await page.waitForSelector('.order-doc', { state: 'attached' });
      await page.emulateMedia({ media: 'print' });
      await expect(page.locator('.order-doc')).toContainText('1.5000 × 0.5000 in');
    });

  // Switching stock drops the size rather than carrying it across, so a poly
  // pro die cannot ride along on an aluminium order.
  test('clears the chosen size when the label type changes', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('radio', { name: 'ToolHound Logo' }).check();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();
    await page.getByRole('radio', { name: '0.75" x 0.75"' }).check();
    await page.getByRole('radio', { name: 'Anodized Aluminum Foil' }).check();
    await page.getByRole('radio', { name: '.002" Premium Poly Pro' }).check();

    await expect(page.getByRole('radio', { name: '0.75" x 0.75"' })).not.toBeChecked();

    await fillQuantity(page, '500');
    await page.getByLabel('Starting Label Number *').fill('1');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Please choose a label size')).toBeVisible();
  });
});

test.describe('typed signature', () => {
  test('renders the typed name as a PNG and submits it', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('Type your name to sign').fill('Dana Reyes');
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    // The database constrains this column to a PNG data URL, which is also
    // what lets the dashboard show it inline.
    expect(row.signature_data).toMatch(/^data:image\/png;base64,/);
    // A blank canvas encodes to a short string; a rendered name does not.
    expect(row.signature_data.length).toBeGreaterThan(1000);
  });

  test('will not submit without a typed signature', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByText('Please type your name to authorize this order')).toBeVisible();
    expect(await page.evaluate(() => window.__INSERTED__)).toHaveLength(0);
  });

  test('clearing the signature blocks submission again', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByLabel('Type your name to sign').fill('Dana Reyes');
    await page.getByRole('button', { name: 'Clear signature' }).click();
    await expect(page.getByLabel('Type your name to sign')).toHaveValue('');

    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();
    await expect(page.getByText('Please type your name to authorize this order')).toBeVisible();
  });
});

/**
 * Regression: the form and the staff dashboard are the same origin and the same
 * Supabase project. With default options they share one stored session, so a
 * staff member signed in to /admin submitted this form as `authenticated` --
 * a role that holds SELECT and no INSERT -- and every submission failed with
 * `permission denied for table label_orders` (PostgREST 42501).
 *
 * These tests bypass the __TOOLHOUND_DB__ stub on purpose and watch the real
 * createClient call, because that is where the defect lived.
 */
test.describe('the public form submits as anon, never as a signed-in user', () => {
  async function stubCreateClient(page) {
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
    await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.addInitScript(() => {
      // The file-level beforeEach installs __TOOLHOUND_DB__, which app.js
      // prefers over createClient. Drop it so the real client path runs --
      // that path is what these tests are about.
      delete window.__TOOLHOUND_DB__;
      window.__INSERTED__ = [];
      window.__CREATE_CLIENT_CALLS__ = [];
      // Stand in for the CDN bundle, which is blocked above.
      window.supabase = {
        createClient(url, key, options) {
          window.__CREATE_CLIENT_CALLS__.push({ url, key, options });
          return {
            from() {
              return {
                insert(row) {
                  window.__INSERTED__.push(row);
                  return Promise.resolve({ error: null });
                }
              };
            }
          };
        }
      };
    });
  }

  test('creates its client with no session read, kept or refreshed',
    async ({ page }) => {
      await stubCreateClient(page);
      await page.goto('/index.html');

      // A staff session left in localStorage by the dashboard, under the key
      // supabase-js uses by default for this project.
      await page.evaluate(() => {
        localStorage.setItem('sb-ayqcteloqdrlemehozzk-auth-token',
          JSON.stringify({ access_token: 'staff.jwt.value', token_type: 'bearer' }));
      });

      await fillStep1(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillStep2(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue to Authorization' }).click();
      await fillStep4(page);
      await page.getByRole('button', { name: 'Submit Order' }).click();

      await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();

      const calls = await page.evaluate(() => window.__CREATE_CLIENT_CALLS__);
      expect(calls).toHaveLength(1);
      const { key, options } = calls[0];
      // The publishable key, so PostgREST runs the insert as anon.
      expect(key).toBe('sb_publishable_DpVxcMatuMmcyqF0B774AQ_y8EuFlp1');
      expect(options.auth.persistSession).toBe(false);
      expect(options.auth.autoRefreshToken).toBe(false);
      expect(options.auth.detectSessionInUrl).toBe(false);
    });

  test('cannot collide with the dashboard session key', async ({ page }) => {
    await stubCreateClient(page);
    await page.goto('/index.html');
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();
    await fillStep4(page);
    await page.getByRole('button', { name: 'Submit Order' }).click();

    const calls = await page.evaluate(() => window.__CREATE_CLIENT_CALLS__);
    const storageKey = calls[0].options.auth.storageKey;
    expect(storageKey).toBeTruthy();
    // Not the default `sb-<ref>-auth-token`, which is what the dashboard uses.
    expect(storageKey).not.toContain('ayqcteloqdrlemehozzk');
  });
});

/**
 * Signing: typed or drawn.
 *
 * Both paths have to end at a PNG data URL, because that is what the database
 * constrains signature_data to and what lets the dashboard render it inline.
 */
test.describe('signature: type or draw', () => {
  test('defaults to typing', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await expect(page.getByRole('radio', { name: 'Type it' })).toBeChecked();
    await expect(page.getByLabel('Type your name to sign')).toBeVisible();
  });

  test('a drawn signature submits as a PNG', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByRole('radio', { name: 'Draw it' }).check();
    // The typed box gives way to the pad.
    await expect(page.getByLabel('Type your name to sign')).toBeHidden();

    const pad = page.locator('canvas.sigpad');
    const box = await pad.boundingBox();
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2 - 20, { steps: 8 });
    await page.mouse.move(box.x + 200, box.y + box.height / 2 + 10, { steps: 8 });
    await page.mouse.up();

    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByRole('heading', { name: 'Order Submitted' })).toBeVisible();
    const row = (await page.evaluate(() => window.__INSERTED__))[0];
    expect(row.signature_data).toMatch(/^data:image\/png;base64,/);
    // A drawn signature has no typed name behind it.
    expect(row.authorized_name).toBe('Dana Reyes');
  });

  test('will not submit an untouched drawing pad', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Authorized Name *').fill('Dana Reyes');
    await page.getByRole('radio', { name: 'Draw it' }).check();
    await page.getByLabel('I have read and agree').check();
    await page.getByRole('button', { name: 'Submit Order' }).click();

    await expect(page.getByText('Please sign in the box to authorize this order')).toBeVisible();
    expect(await page.evaluate(() => window.__INSERTED__.length)).toBe(0);
  });

  // Switching modes must not carry the old signature over: the record has to
  // match the method the customer actually used.
  test('switching modes clears what was there', async ({ page }) => {
    await fillStep1(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillStep2(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue to Authorization' }).click();

    await page.getByLabel('Type your name to sign').fill('Dana Reyes');
    await page.getByRole('radio', { name: 'Draw it' }).check();
    await page.getByRole('radio', { name: 'Type it' }).check();
    await expect(page.getByLabel('Type your name to sign')).toHaveValue('');
  });
});

/* ---------------------------------------------------------------------------
   The label order document
   This is the sheet the customer signs and Metalcraft works from, so these
   tests care about what it states rather than how it looks. A wrong value here
   is a scrapped print run, not a cosmetic bug.
   --------------------------------------------------------------------------- */

test.describe('label order document', () => {
  test('the quote number is required, and names itself when missing', async ({ page }) => {
    await gotoForm(page);
    await fillStep1(page, { quote: '' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.field', { hasText: 'ToolHound Quote Number' })
      .locator('.err-msg')).toBeVisible();
    // And the form has not advanced.
    await expect(page.getByLabel('Company Name *')).toBeVisible();
  });

  test('the printed document carries the quote number as the reference',
    async ({ page }) => {
      await submitOrder(page, { quote: 'GC-26-175D' });
      await page.emulateMedia({ media: 'print' });
      const doc = page.locator('.order-doc');
      await expect(doc).toHaveCount(1);
      // Header, reference strip and footer all carry it: the whole point is
      // that Metalcraft can quote it back from anywhere on the page.
      await expect(doc.locator('.od-dv', { hasText: 'GC-26-175D' })).toBeVisible();
      await expect(doc.locator('.od-rv', { hasText: 'GC-26-175D' })).toBeVisible();
      await expect(doc.locator('.od-foot')).toContainText('GC-26-175D');
    });

  test('the shipping address is the only address on the sheet', async ({ page }) => {
    await submitOrder(page);
    const doc = page.locator('.order-doc');
    // The customer's address is present and labelled as the ship-to.
    await expect(doc.locator('.od-shipto')).toContainText('400 Foundry Rd');
    await expect(doc.locator('.od-shipto')).toContainText('Hamilton');
    await expect(doc.locator('.od-shipto .od-lab')).toContainText('Ship to');
    // ToolHound's own postal address is deliberately absent. Ian removed it so
    // there is exactly one place to ship to on the page.
    await expect(doc).not.toContainText('Carnegie');
    await expect(doc).not.toContainText('St Albert');
  });

  test('correspondence goes to the shared mailboxes, not a person',
    async ({ page }) => {
      await submitOrder(page);
      const doc = page.locator('.order-doc');
      await expect(doc).toContainText('sales@toolhound.com');
      await expect(doc).toContainText('accounting@toolhound.com');
      await expect(doc).not.toContainText('graham.cooper@toolhound.com');
    });

  test('the sequence splits into prefix, from and to', async ({ page }) => {
    await submitOrder(page, { seqStart: 'TSG-0001', quantity: '500' });
    const row = page.locator('.order-doc .od-tbl').last().locator('tbody td');
    await expect(row.nth(1)).toHaveText('TSG-');
    await expect(row.nth(2)).toHaveText('0001');
    // Padding survives the count: 500 labels from TSG-0001 ends TSG-0500, and
    // dropping the zeros would have the vendor print the wrong labels.
    await expect(row.nth(3)).toHaveText('0500');
  });

  test('the die size is stated to four decimals, as the vendor states it',
    async ({ page }) => {
      await submitOrder(page);
      await expect(page.locator('.order-doc .od-tbl').first())
        .toContainText('1.5000 × 0.7500 in');
    });

  test('removed fields stay removed', async ({ page }) => {
    await submitOrder(page);
    const doc = page.locator('.order-doc');
    for (const gone of ['Symbology', 'Ship via', 'Required by', 'Order desk']) {
      await expect(doc).not.toContainText(gone);
    }
  });

  test('the customer signature is the only one on the document',
    async ({ page }) => {
      await submitOrder(page, { authorizedName: 'Nick Tibbles' });
      await page.emulateMedia({ media: 'print' });
      const auth = page.locator('.order-doc .od-auth');
      await expect(auth.locator('.od-sig')).toHaveCount(3);
      await expect(auth).toContainText('Nick Tibbles');
      await expect(auth.locator('.od-sigimg')).toBeVisible();
      await expect(auth).not.toContainText('Countersigned');
    });

  test('the sequence split is exercised directly for the awkward shapes',
    async ({ page }) => {
      await gotoForm(page);
      const cases = await page.evaluate(() => {
        const s = window.TOOLHOUND_ORDER_DOC.splitSequence;
        return {
          plain: s('10000', 5000),
          padded: s('TSG-0001', 500),
          lettersRun: s('VOL6001', 3000),
          // A run that outgrows its padding gets longer rather than truncating.
          outgrows: s('0001', 20000),
          noDigits: s('ABC', 500),
          noQuantity: s('1000', '')
        };
      });
      expect(cases.plain).toMatchObject({ prefix: '', from: '10000', to: '14999' });
      expect(cases.padded).toMatchObject({ prefix: 'TSG-', from: '0001', to: '0500' });
      expect(cases.lettersRun).toMatchObject({ prefix: 'VOL', from: '6001', to: '9000' });
      expect(cases.outgrows).toMatchObject({ from: '0001', to: '20000' });
      expect(cases.noDigits).toMatchObject({ prefix: 'ABC', from: '', to: '' });
      expect(cases.noQuantity).toMatchObject({ from: '1000', to: '' });
    });
});
