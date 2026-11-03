// Redaction rules without a browser: what must be removed, what must stay
// (developer-useful data such as stack frames), and that large inputs stay fast.
import { fileURLToPath } from 'node:url';

globalThis.FL_CONST = { DEV_RESULTS: [], VERDICTS: [], CATEGORIES: [], PRIORITIES: [], STATUSES: [], LIMITS: { text: 400, htmlSnippet: 2500 } };
globalThis.location = { href: 'https://app.example.com/start', origin: 'https://app.example.com' };
globalThis.CSS = { escape: (s) => s };
const src = (p) => fileURLToPath(new URL(`../extension/src/${p}`, import.meta.url));
await import(src('shared/sanitize.js'));
await import(src('content/context.js'));
const { redact } = globalThis.FL_SAN;
const X = globalThis.FL_CTX;

const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(label);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const removed = {
  '{user: max, password: geheim}': '{user: max, password: ***}',
  '{"email":"max@firma.de","token":"abc"}': '{"email":"[E-Mail entfernt]","token":"***"}',
  'Password: Sommer2024!': 'Password: ***',
  'Authorization: Bearer abcdefghijklmnop1234': 'Authorization: Bearer [entfernt]',
  'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl': 'JWT [Token entfernt]',
  'key sk_live_51HxAbCdEfGhIjKlMnOp': 'key [Schlüssel entfernt]',
  'AKIAIOSFODNN7EXAMPLE': '[Schlüssel entfernt]',
  'Karte 4111 1111 1111 1111 abgelehnt': 'Karte [Kartennummer entfernt] abgelehnt',
  '"cardNumber":"4111111111111111"': '"cardNumber":"[Kartennummer entfernt]"',
  'IBAN DE89 3704 0044 0532 0130 00': 'IBAN [IBAN entfernt]',
  'PHPSESSID=abc123def456; JSESSIONID=1A2B3C': 'PHPSESSID=***; JSESSIONID=***',
  '"sessionId": "a1b2c3d4e5"': '"sessionId": "***"',
  'otp: 123456': 'otp: ***',
  'Token zXq9Lm2Pw8Rt5Yu1Io3Kj7Hg6Fd4Sa0Qe9Wr2Ty5 im Text': 'Token [entfernt] im Text',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----': '[privater Schlüssel entfernt]',
};
for (const [input, expected] of Object.entries(removed)) {
  const out = redact(input);
  check(out === expected, `entfernt: ${JSON.stringify(input).slice(0, 60)}`, out);
}

const kept = [
  'at useAuth (webpack-internal:///./src/hooks/useAuth.ts:12:5)',
  'at AuthGuard (auth.guard.ts:25:11)',
  'tokenStorage.ts:44:17',
  'session.ts:42 Uncaught TypeError',
  'AuthContext.Provider: value=undefined',
  '{"tokenExpiry": 3600, "sessionTimeout": 1800, "maxTokens": 4096}',
  'Passwort: mindestens 8 Zeichen',
  'Passwort: ungültig',
  'Token: läuft ab',
  'Token abgelaufen, bitte neu anmelden',
  'passwordHint: "mind. 8 Zeichen"',
  'EAN 4006381333931',
  'Bestellung 4000123456789 Zeit 1730000000000',
  'uuid 550e8400-e29b-41d4-a716-446655440000',
  'main.3f2a1b9c4d5e6f7a8b9c0d1e2f3a4b5c.js',
  '/api/v1/UsersController/getAllUsersWithPermissions failed',
  'ProductCard-price-discounted-2024x',
  'logo@2x.png',
  '<input type="password" name="password" autocomplete="current-password" placeholder="Passwort">',
  'Server error 500: {"error":"Datenbank nicht erreichbar","requestId":"r-123"}',
];
for (const input of kept) {
  const out = redact(input);
  check(out === input, `bleibt: ${JSON.stringify(input).slice(0, 60)}`, out);
}

const urls = {
  'https://app.example.com/x?PHPSESSID=abc&page=2': 'https://app.example.com/x?PHPSESSID=***&page=2',
  'https://app.example.com/a;jsessionid=ABC123?x=1': 'https://app.example.com/a;jsessionid=***?x=1',
  'https://app.example.com/cb#access_token=abc.def&state=1': 'https://app.example.com/cb#access_token=***&state=1',
  [`https://app.example.com/login?redirect=${encodeURIComponent('https://app.example.com/x?token=abc')}`]: 'https://app.example.com/login?redirect=https%3A%2F%2Fapp.example.com%2Fx%3Ftoken%3D***',
  'https://max:geheim@app.example.com/x': 'https://***:***@app.example.com/x',
  'https://app.example.com/users/max@firma.de/edit': 'https://app.example.com/users/***/edit',
  'https://app.example.com/static/js/auth.js': 'https://app.example.com/static/js/auth.js',
  '/relative/path?q=1': '/relative/path?q=1',
};
for (const [input, expected] of Object.entries(urls)) {
  const out = X.maskUrl(input, true);
  check(out === expected, `Adresse: ${input.slice(0, 60)}`, out);
}
check(X.maskUrl(`data:image/svg+xml,${'x'.repeat(50000)}`, true) === 'data:image/svg+xml,…', 'data:-Adressen gekürzt');

// Large inputs: linear time (the slowest case used to take seconds)
const big = {
  'SVG als data:-Adresse': `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg">' + '<path d="M1 2L3 4"/>'.repeat(2000) + '</svg>')}`,
  'Zustand in der Adresse': `https://x.de/app?state=${encodeURIComponent(JSON.stringify({ a: 'x'.repeat(50000), b: Array.from({ length: 3000 }, (_, i) => `item${i}@`) }))}`,
  'viele @': 'a@'.repeat(20000),
  'langes Wort': 'abcdefghij'.repeat(10000),
  'eyJ ohne Punkte': `eyJ${'a'.repeat(50000)}`,
  'offene Anführungszeichen': 'token:"'.repeat(5000),
  'Punkte': 'a.'.repeat(50000),
};
for (const [name, value] of Object.entries(big)) {
  const t = performance.now();
  redact(value);
  X.maskUrl(value, true);
  const ms = performance.now() - t;
  check(ms < 250, `schnell: ${name} (${value.length} Zeichen, ${Math.round(ms)} ms)`);
}

console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
