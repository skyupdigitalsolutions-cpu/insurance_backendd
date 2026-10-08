// Draws the quotation PDF from the stored snapshot (so the PDF always matches the quotation).
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { QuotationDoc } from './quotation.model.js';

const require = createRequire(import.meta.url);
// DejaVu Sans includes the ₹ sign (the built-in PDF fonts do not)
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const BLUE = '#3A75C4';
const DARK = '#1A2433';
const MUTED = '#5B6B80';
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
// "+919876543210" → "+91 98765 43210"
const phone = (m: string) => (/^\+91\d{10}$/.test(m) ? `+91 ${m.slice(3, 8)} ${m.slice(8)}` : m);
const date = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export type PdfAdvisor = { agencyName: string; advisorName: string; mobile: string; irdaiNumber: string | null };

export function renderQuotationPdf(q: QuotationDoc, advisor: PdfAdvisor): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Quotation ${q.quoteNumber}`, Author: advisor.agencyName } });
  doc.registerFont('body', FONT).registerFont('bold', FONT_BOLD);
  const W = doc.page.width - 96;

  // Header band
  doc.rect(0, 0, doc.page.width, 92).fill(BLUE);
  doc.fillColor('#FFFFFF').font('bold').fontSize(18).text(advisor.agencyName, 48, 26, { width: W * 0.6 });
  doc.font('body').fontSize(9).text(`${advisor.advisorName} · ${phone(advisor.mobile)}${advisor.irdaiNumber ? ` · IRDAI ${advisor.irdaiNumber}` : ''}`, 48, 52, { width: W * 0.6 });
  doc.font('bold').fontSize(16).text('QUOTATION', 48, 26, { width: W, align: 'right' });
  doc.font('body').fontSize(9).text(q.quoteNumber, 48, 48, { width: W, align: 'right' });

  doc.fillColor(DARK).moveDown(0);
  let y = 112;
  const row = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
    doc.font('body').fontSize(10).fillColor(MUTED).text(label, 48, y, { width: W * 0.6 });
    doc.font(opts.bold ? 'bold' : 'body').fillColor(opts.color ?? DARK).text(value, 48, y, { width: W, align: 'right' });
    y += 18;
  };
  const section = (title: string) => {
    y += 8;
    doc.font('bold').fontSize(11).fillColor(BLUE).text(title, 48, y);
    y += 16;
    doc.moveTo(48, y).lineTo(48 + W, y).strokeColor('#D9E2EE').lineWidth(1).stroke();
    y += 8;
  };

  section('Details');
  row('Customer', q.customerName);
  row('Date', date(q.createdAt));
  row('Valid until', date(q.validUntil));
  row('Payment', q.frequency === 'Monthly' ? 'Monthly instalments' : 'Yearly');

  section('Plan');
  row('Product', q.product.name, { bold: true });
  row('Insurer', q.product.companyName);
  row('Insurance type', q.product.type);
  if (q.product.coverage) row('Coverage', q.product.coverage);

  section('Premium');
  row('Base premium (yearly)', inr(q.pricing.base));
  for (const a of q.addOns) row(`Add-on: ${a.name}`, inr(a.premium));
  row('Subtotal', inr(q.pricing.subtotal));
  if (q.pricing.discount > 0) row(`Discount (${q.discountPercent}%)`, `– ${inr(q.pricing.discount)}`, { color: '#2E7D32' });
  row(q.pricing.gstRate === 0 ? 'GST (exempt)' : `GST (${Math.round(q.pricing.gstRate * 100)}%)`, inr(q.pricing.gst));
  y += 4;
  doc.rect(48, y - 4, W, 26).fill('#EAF1FB');
  row(q.frequency === 'Monthly' ? 'Monthly instalment' : 'Total payable (yearly)', inr(q.pricing.total), { bold: true, color: BLUE });
  y += 6;

  if (q.product.features.length) {
    section('Key features');
    for (const f of q.product.features) {
      doc.font('body').fontSize(10).fillColor(DARK).text(`•  ${f}`, 56, y, { width: W - 8 });
      y = doc.y + 4;
    }
  }
  if (q.product.exclusions) {
    section('Main exclusions');
    doc.font('body').fontSize(10).fillColor(DARK).text(q.product.exclusions, 48, y, { width: W });
    y = doc.y + 4;
  }

  // Footer: standard disclosure
  doc.font('body').fontSize(8).fillColor(MUTED).text(
    'Insurance is the subject matter of solicitation. The premium shown is indicative and subject to the insurer\'s underwriting, ' +
      'policy terms and the information provided. Please read the policy wordings and sales brochure carefully before buying.',
    48, doc.page.height - 96, { width: W, align: 'center' },
  );
  doc.end();
  return doc;
}
