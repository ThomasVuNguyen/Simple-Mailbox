// Finds the verification code or link in an email, so neither a person nor an agent has to read it.

// Footers say "security" and "confirm" too, next to street numbers and zip codes, so those words are left out.
const CODE_WORDS = /\b(code|verification|verify|otp|passcode|pin|one[- ]time|log ?in|sign[- ]?in|authenticat\w*|2fa)\b/gi;
const LINK_INTENT = /\b(verify|verification|confirm|activate|magic link|sign[- ]?in|log ?in|validate|reset)\b/i;
const LINK_GOOD = /(verif|confirm|activat|validat|magic|login|log-in|signin|sign-in|sign_in|auth|token|reset|callback)/i;
const LINK_BAD = /(unsubscribe|preferences|privacy|terms|legal|help|support|twitter\.com|x\.com|facebook|linkedin|instagram|youtube|tiktok|mailto:|\.(png|jpe?g|gif|svg|webp)(\?|$))/i;

// 6 digits split 3+3 ("482 913", "482-913"), or 4 to 8 digits, not part of a larger number, price or date.
const DIGITS = /(?<![\d$€£#.,/:-])(\d{3}[ -]\d{3}|\d{4,8})(?![\d%]|[.,:/-]\d)/g;
// 6 to 8 characters of capitals and digits with at least one of each, e.g. "K7Q2MX".
const ALNUM = /(?<![A-Za-z0-9])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}(?![A-Za-z0-9])/g;

function cleanDigits(raw: string): string | null {
  const code = raw.replace(/[ -]/g, '');
  if (code.length === 4 && /^(19|20)\d\d$/.test(code)) return null; // a year
  if (/^(\d)\1+$/.test(code)) return null; // 0000, 111111
  return code;
}

function firstCode(window: string): string | null {
  for (const m of window.matchAll(DIGITS)) {
    const code = cleanDigits(m[1]);
    if (code) return code;
  }
  for (const m of window.matchAll(ALNUM)) return m[0];
  return null;
}

/** The verification code in an email, or null. Looks near words like "code" and "verify" only. */
export function extractCode(subject: string, text: string): string | null {
  for (const source of [subject, text.replace(/\s+/g, ' ')]) {
    for (const k of source.matchAll(CODE_WORDS)) {
      const at = k.index ?? 0;
      // "Your code is 482913" and "482913 is your code"
      const after = firstCode(source.slice(at, at + k[0].length + 80));
      if (after) return after;
      const before = firstCode(source.slice(Math.max(0, at - 24), at));
      if (before) return before;
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** The verification or sign-in link in an email, or null. Only for emails that talk about verifying or signing in. */
export function extractLink(subject: string, text: string, html: string | null): string | null {
  // Judge intent from the subject and the opening words, not from URLs or footers ("Log in to manage...").
  const opening = text.replace(/https?:\/\/\S+/g, ' ').slice(0, 600);
  if (!LINK_INTENT.test(subject) && !LINK_INTENT.test(opening)) return null;
  const urls: string[] = [];
  if (html) for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) urls.push(decodeEntities(m[1]).trim());
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"']+/g)) urls.push(m[0].replace(/[.,;]+$/, ''));
  return urls.find((u) => /^https?:\/\//i.test(u) && LINK_GOOD.test(u) && !LINK_BAD.test(u)) ?? null;
}

/** Readable plain text from an HTML email, for emails that have no text part. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "482913" reads as "482 913". Other codes are left alone. */
export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

// "On Tue, Nov 17, 2026 at 12:42 PM <thomas@beenex.company> wrote:", which Gmail may wrap over two lines.
const QUOTE_STARTS = [
  /\n[ \t]*On [^\n]{1,200}(\n[^\n]{1,200})?wrote:[ \t]*\n/,
  /\n[ \t]*-{2,}\s*Original Message\s*-{2,}/i,
  /\n[ \t]*From: [^\n]+\n[ \t]*(Sent|Date): /,
];

/** Splits a reply into what the person wrote and the earlier emails they quoted below it. */
export function splitQuoted(text: string): { main: string; quoted: string } {
  const t = `\n${text.replace(/\r\n/g, '\n')}`;
  let at = -1;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(t);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) {
    // A trailing block of "> " lines.
    const lines = t.split('\n');
    let i = lines.length;
    while (i > 0 && (lines[i - 1].startsWith('>') || !lines[i - 1].trim())) i--;
    if (i < lines.length && lines.slice(i).some((l) => l.startsWith('>'))) at = lines.slice(0, i).join('\n').length;
  }
  if (at < 0) return { main: text.trim(), quoted: '' };
  const main = t.slice(0, at).trim();
  return main ? { main, quoted: t.slice(at).trim() } : { main: text.trim(), quoted: '' };
}
