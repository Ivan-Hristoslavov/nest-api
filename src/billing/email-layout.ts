/**
 * The frame every message from PriceGuard arrives in.
 *
 * Email is not a browser. Flexbox, grid and external stylesheets are ignored
 * or mangled by enough clients that the only reliable layout is nested tables
 * with inline styles, which is why this reads like 2005 — it is the format
 * that renders the same in Gmail, Outlook and Apple Mail rather than a
 * stylistic choice.
 *
 * It exists as one function because the alternative is what was here before:
 * each message inventing its own markup, so the key that arrives after payment
 * and the alert that arrives at 3am look like they come from two companies.
 */

const ACCENT = '#0d9488';
const INK = '#11141b';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const PAGE = '#f4f5f7';

/**
 * Set on every element that holds text, not once on the body.
 *
 * Outlook renders through Word, which drops inherited font families and falls
 * back to Times — so a stack declared only on `body` produces a serif email
 * for a large share of business inboxes.
 */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface EmailBlock {
  html: string;
  text: string;
}

export interface EmailOptions {
  title: string;
  /** The grey line under the subject in most inboxes. Worth writing. */
  preheader: string;
  heading: string;
  body: EmailBlock[];
  cta?: { label: string; url: string };
  /** Small print under the divider: what to do next, who to ask. */
  footnotes?: string[];
  supportEmail?: string;
  appUrl: string;
}

/** A paragraph. */
export function paragraph(html: string, text = stripTags(html)): EmailBlock {
  return {
    html: `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${TEXT}">${html}</p>`,
    text,
  };
}

/**
 * Something to be copied exactly — a key, a code.
 *
 * Dark on purpose: it has to be findable when the reader scrolls back through
 * a year of mail looking for "that message with the key in it".
 */
export function codeBlock(value: string, caption?: string): EmailBlock {
  return {
    html: `
      ${caption ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;color:${MUTED}">${escapeHtml(caption)}</p>` : ''}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px">
        <tr>
          <td style="padding:14px 16px;background:${INK};border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#5eead4;word-break:break-all">${escapeHtml(value)}</td>
        </tr>
      </table>`,
    text: caption ? `${caption}\n${value}` : value,
  };
}

/** A fact worth boxing: a warning, a limit, a thing not to lose. */
export function noticeBox(html: string, tone: 'warn' | 'info' = 'info'): EmailBlock {
  const background = tone === 'warn' ? '#fffbeb' : '#f0fdfa';
  const border = tone === 'warn' ? '#fcd34d' : '#99f6e4';

  return {
    html: `
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px">
        <tr>
          <td style="padding:12px 14px;background:${background};border:1px solid ${border};border-radius:10px;font-family:${FONT};font-size:14px;line-height:1.6;color:${TEXT}">${html}</td>
        </tr>
      </table>`,
    text: stripTags(html),
  };
}

/** Label/value rows — a price comparison, an account summary. */
export function dataRows(rows: Array<[string, string]>): EmailBlock {
  if (rows.length === 0) return { html: '', text: '' };

  const cells = rows
    .map(
      ([label, value], index) => `
        <tr>
          <td style="padding:${index === 0 ? '0' : '8px'} 16px 8px 0;font-family:${FONT};font-size:14px;color:${MUTED};white-space:nowrap">${escapeHtml(label)}</td>
          <td style="padding:${index === 0 ? '0' : '8px'} 0 8px;font-family:${FONT};font-size:14px;font-weight:600;color:${TEXT}">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('');

  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${cells}</table>`,
    text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
  };
}

/**
 * Wraps the content in the frame.
 *
 * The preheader is the first thing an inbox shows after the subject and the
 * last thing anyone remembers to write, so it is a required argument rather
 * than an option — left to default it becomes the first words of the layout,
 * which in most emails is a legal disclaimer.
 */
export function renderEmail(options: EmailOptions): { html: string; text: string } {
  const body = options.body.map((block) => block.html).join('\n');

  const cta = options.cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">
        <tr>
          <td style="border-radius:10px;background:${ACCENT}">
            <a href="${escapeAttribute(options.cta.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(options.cta.label)}</a>
          </td>
        </tr>
      </table>`
    : '';

  const footnotes = (options.footnotes ?? [])
    .map(
      (note) =>
        `<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED}">${note}</p>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAGE};font-family:${FONT}">
    <!-- Shown by the inbox next to the subject, then hidden in the message. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(options.preheader)}</div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PAGE}">
      <tr>
        <td align="center" style="padding:28px 12px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
            <tr>
              <td style="padding:18px 28px;background:${INK}">
                <span style="font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.01em">PriceGuard</span>
                <span style="font-family:${FONT};font-size:13px;color:#94a3b8"> · цените на вашите доставчици</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px">
                <h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:700;color:${INK}">${escapeHtml(options.heading)}</h1>
                ${body}
                ${cta}
              </td>
            </tr>
            ${
              footnotes
                ? `<tr>
              <td style="padding:18px 28px;border-top:1px solid ${LINE};background:#fbfbfc">${footnotes}</td>
            </tr>`
                : ''
            }
            <tr>
              <td style="padding:16px 28px;border-top:1px solid ${LINE};background:#fbfbfc">
                <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">
                  <a href="${escapeAttribute(options.appUrl)}" style="color:${ACCENT};text-decoration:none">${escapeHtml(hostOf(options.appUrl))}</a>
                  ${
                    options.supportEmail
                      ? ` · <a href="mailto:${escapeAttribute(options.supportEmail)}" style="color:${ACCENT};text-decoration:none">${escapeHtml(options.supportEmail)}</a>`
                      : ''
                  }
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    options.heading,
    '',
    ...options.body.map((block) => block.text).filter(Boolean),
    options.cta ? `\n${options.cta.label}: ${options.cta.url}` : '',
    ...(options.footnotes ?? []).map(stripTags),
    '',
    hostOf(options.appUrl),
    options.supportEmail ?? '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { html, text };
}

function hostOf(url: string): string {
  if (!url) return 'priceguard';

  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

/** Tags out, entities back to characters — the plain-text twin of a block. */
function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
