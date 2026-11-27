/**
 * Masks personal and card data before the text leaves the machine.
 * Every replacement keeps the original length, so character offsets — and therefore
 * quote verification against the unmasked source — stay valid.
 */

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const maskDigits = (s: string, keepLast = 0): string => {
  const total = s.replace(/\D/g, '').length;
  let seen = 0;
  return s.replace(/\d/g, (d) => (++seen > total - keepLast ? d : '#'));
};

export interface Redaction {
  text: string;
  count: number;
  kinds: string[];
}

export function redact(text: string): Redaction {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;

  // Card numbers: 13–19 digits, optionally grouped, Luhn-valid. The last four digits stay, as on a receipt.
  out = out.replace(/(?<![\d#])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    count++;
    kinds.add('номер карты');
    return maskDigits(m, 4);
  });
  // Kazakhstan IBAN.
  out = out.replace(/(?<![A-Z0-9])KZ\d{2}[A-Z0-9]{16}(?![A-Z0-9])/g, (m) => {
    count++;
    kinds.add('IBAN');
    return `${m.slice(0, 4)}${'#'.repeat(m.length - 4)}`;
  });
  // IIN/BIN: exactly 12 digits next to the word that names it.
  out = out.replace(/((?:ИИН|БИН|IIN|BIN)\s*[:№]?\s*)(\d{12})(?!\d)/giu, (_m, lead: string, id: string) => {
    count++;
    kinds.add('ИИН');
    return `${lead}${'#'.repeat(id.length)}`;
  });
  // Phone numbers in the +7 / 8 formats.
  out = out.replace(/(?<![\d#])(?:\+7|8)[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)/g, (m) => {
    count++;
    kinds.add('телефон');
    return maskDigits(m, 2);
  });
  // E-mail: the local part is masked, the domain stays (it is rarely personal and helps to understand the text).
  out = out.replace(/(?<![\w.+-])([\w.+-]{2,})@([\w-]+(?:\.[\w-]+)+)/g, (_m, local: string, domain: string) => {
    count++;
    kinds.add('e-mail');
    return `${'#'.repeat(local.length)}@${domain}`;
  });
  return { text: out, count, kinds: [...kinds] };
}
