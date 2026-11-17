import { describe, expect, it } from 'vitest';
import { extractCode, extractLink, formatCode, htmlToText } from '../src/shared/extract';
import { mailboxAddress } from '../src/worker/inbound';

describe('extractCode', () => {
  it.each([
    ['Your Linear login code', 'Enter this code to sign in: 482913. It expires in 10 minutes.', '482913'],
    ['482913 is your verification code', '', '482913'],
    ['Verify your email', 'Your verification code is 482 913', '482913'],
    ['Sign in to Acme', 'Use code 482-913 to sign in.', '482913'],
    ['Your one-time passcode', 'Passcode: 4829', '4829'],
    ['Confirm your device', 'Enter the verification code K7Q2MX in the app.', 'K7Q2MX'],
    ['[GitHub] Please verify your device', 'Verification code: 305118\n\nIf you did not attempt to sign in...', '305118'],
  ])('%s', (subject, text, code) => {
    expect(extractCode(subject, text)).toBe(code);
  });

  it.each([
    ['Welcome to The Browser', 'Here is your first issue. 5 links worth reading. Unsubscribe.'],
    ['Your trial ends in 3 days', 'Upgrade for $1,299 a year. Offer ends 2026-12-01.'],
    ['Your code review is ready', 'Pull request #48213 has 12 comments.'],
    ['Sign in to read more', 'Log in to read the 2026 edition.'],
    ['Newsletter', 'Acme Inc, 548 Market St, San Francisco CA 94104. Security and privacy.'],
  ])('finds no code in "%s"', (subject, text) => {
    expect(extractCode(subject, text)).toBeNull();
  });
});

describe('extractLink', () => {
  it('finds the confirm link and skips unsubscribe', () => {
    const html = '<a href="https://acme.com/unsubscribe?u=1">Unsubscribe</a> <a href="https://acme.com/confirm?token=abc&amp;u=1">Confirm</a>';
    expect(extractLink('Confirm your subscription', '', html)).toBe('https://acme.com/confirm?token=abc&u=1');
  });

  it('finds a magic link in plain text', () => {
    expect(extractLink('Sign in to Acme', 'Click https://acme.com/auth/magic?t=xyz. It expires soon.', null)).toBe('https://acme.com/auth/magic?t=xyz');
  });

  it('ignores links in emails that are not about verifying', () => {
    expect(extractLink('Weekly digest', 'Read more at https://acme.com/login', null)).toBeNull();
  });
});

describe('helpers', () => {
  it('htmlToText keeps paragraphs and drops styles', () => {
    expect(htmlToText('<style>p{}</style><p>Hello&nbsp;there</p><p>Code: <b>123456</b></p>')).toBe('Hello there\nCode: 123456');
  });

  it('formatCode splits 6 digits only', () => {
    expect(formatCode('482913')).toBe('482 913');
    expect(formatCode('K7Q2MX')).toBe('K7Q2MX');
  });

  it('plus addressing goes to the base mailbox', () => {
    expect(mailboxAddress('Signups+Linear@Beenex.Company')).toBe('signups@beenex.company');
  });
});
