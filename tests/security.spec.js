const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('../vercel.json');
const policy = config.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
test('CSP authorizes the exact bootstrap scripts and SDK is pinned with integrity', () => {
  const scriptPolicy = policy.split(';').find(p => p.trim().startsWith('script-src'));
  expect(scriptPolicy).not.toContain("'unsafe-inline'");
  expect(scriptPolicy).not.toContain("'unsafe-eval'");
  for (const file of fs.readdirSync('public').filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync('public/' + file, 'utf8');
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(scriptPolicy).toContain("'sha256-" + crypto.createHash('sha256').update(script).digest('base64') + "'");
    }
    for (const [script] of html.matchAll(/<script[^>]*src="https:[^>]+>/g)) {
      expect(script).toContain('@2.118.0/');
      expect(script).toContain('integrity="sha384-');
      expect(script).toContain('crossorigin="anonymous"');
    }
  }
});
for (const variant of ['linear', 'qr']) {
  test('CSP permits ' + variant + ' form while blocking injected inline JavaScript', async ({ page }) => {
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await page.addInitScript(variant => {
      window.__TOOLHOUND_DB__ = { functions: { invoke: async () => ({ data: {
        barcode_type: variant, mode: 'live', prefill: { companyName: 'Acme', contactName: 'Dana', contactEmail: 'dana@example.com' }
      } }) } };
    }, variant);
    const filename = variant === 'linear' ? 'linear-barcode.html' : 'qr-code.html';
    await page.route('**/' + filename, async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('</body>', '<script>window.__injected = true</script></body>');
      await route.fulfill({ response, body, headers: { ...response.headers(), 'content-security-policy': policy } });
    });
    await page.goto('/' + filename + '#request=12345678-1234-4234-9234-123456789012&token=' + 'a'.repeat(64));
    await expect.poll(() => page.locator('input').evaluateAll(inputs => inputs.some(i => i.value === 'Acme'))).toBe(true);
    expect(await page.evaluate(() => window.TOOLHOUND_FORM_VARIANT)).toBe(variant);
    expect(await page.evaluate(() => window.__injected)).toBeUndefined();
    expect(await page.locator('input').evaluateAll(inputs => inputs.some(i => i.value === 'Acme'))).toBe(true);
  });
}
