// Render the same document as the browser. Bundle with scripts/bundle-order-requests.mjs
// so configuration, document wording and the logo cannot drift between copies.
import pdfMake from 'npm:pdfmake@0.2.20/build/pdfmake.js';
import fonts from 'npm:pdfmake@0.2.20/build/vfs_fonts.js';
import htmlToPdfmake from 'npm:html-to-pdfmake@2.5.32';
import { parseHTML } from 'npm:linkedom@0.18.12';
import '../../../public/config.js';
import '../../../public/order-doc.js';
import logo from '../../../public/toolhound-logo.png';

export async function generateOrderPdf(row: any, audience: 'vendor' | 'record') {
  const { document, window } = parseHTML('<html><body></body></html>');
  const shared = (globalThis as any).TOOLHOUND_CREATE_ORDER_DOC(document, (globalThis as any).TOOLHOUND_CONFIG);
  const node = shared.render(shared.fromRow(row), { audience });
  node.querySelector('.od-brand img').setAttribute('src', logo);
  // Pagination belongs to the PDF engine, not the single-sheet browser header.
  node.querySelector('.od-title').lastElementChild.remove();
  // Translate layout-only CSS grids into PDF tables; content remains the shared DOM.
  for (const selector of ['.od-kv', '.od-head', '.od-parties', '.od-two', '.od-siggrid', '.od-foot']) {
    for (const group of Array.from(node.querySelectorAll(selector)) as any[]) {
      const children = Array.from(group.children) as any[];
      const table = document.createElement('table');
      const rows = selector === '.od-kv'
        ? Array.from({ length: children.length / 2 }, (_, i) => children.slice(i * 2, i * 2 + 2))
        : [children];
      table.setAttribute('data-pdfmake', JSON.stringify({ widths: rows[0].map(() => '*'), layout: 'noBorders' }));
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);
      for (const cells of rows) {
        const tr = document.createElement('tr');
        for (const child of cells) {
          const td = document.createElement('td'); td.appendChild(child); tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      group.replaceWith(table);
    }
  }
  for (const line of Array.from(node.querySelectorAll('.od-drow, .od-ref, .od-sig')) as any[]) {
    if (line.firstElementChild) line.firstElementChild.appendChild(document.createTextNode('  '));
  }
  const content = htmlToPdfmake(`<html><body>${node.outerHTML}</body></html>`, { window, tableAutoSize: true,
    defaultStyles: { div: { margin: [0, 0, 0, 2] }, p: { margin: [0, 0, 0, 4] }, th: { bold: true, fillColor: '#F1EEEB' }, td: { margin: [3, 3, 3, 3] } } });
  const definition = {
    pageSize: 'LETTER', pageMargins: [32, 28, 32, 32],
    info: { title: `${audience === 'vendor' ? 'Vendor copy' : 'Signed order'} ${row.order_ref}`, author: 'ToolHound' },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#201B1A', lineHeight: 1.1 },
    styles: {
      'od-brand': { margin: [0, 0, 0, 10] },
      'od-dt': { fontSize: 20, bold: true, margin: [0, 0, 0, 6] },
      'od-lab': { bold: true }, 'od-nm': { bold: true },
      'od-party': { margin: [0, 4, 0, 4] },
      'od-refs': { margin: [0, 8, 0, 8] },
      'od-sec': { fontSize: 11, bold: true, margin: [0, 12, 0, 6], color: '#B91F24' },
      'od-kv': { margin: [0, 8, 0, 8] },
      'od-block': { margin: [0, 8, 0, 8] },
      'od-foot': { fontSize: 8, margin: [0, 14, 0, 0], color: '#5B5352' },
      'od-sig': { margin: [0, 6, 0, 6] }
    },
    footer: (current: number, total: number) => ({ text: `${row.order_ref}  ·  ${current} / ${total}`, alignment: 'right', margin: [32, 0, 32, 0], fontSize: 8 }),
    content
  };
  // Attribute sizing works in both html-to-pdfmake and the browser DOM adapter.
  function sizeImages(items: any) {
    if (!items || typeof items !== 'object') return;
    if (items.image) items.fit = items.style?.includes('od-sigimg') ? [180, 60] : [100, 42];
    for (const value of Object.values(items)) if (typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(sizeImages); else sizeImages(value);
    }
  }
  sizeImages(content);
  return await new Promise<Uint8Array>((resolve, reject) => {
    try { pdfMake.createPdf(definition, undefined, undefined, fonts).getBuffer((bytes: Uint8Array) => resolve(new Uint8Array(bytes))); }
    catch (error) { reject(error); }
  });
}
