// Safe arithmetic for number fields ("100+20", "*2", "(3+4)/2", "-5", "1e3").
// The app's Content Security Policy forbids eval/Function, so this is a tiny parser.

export function evalArithmetic(src: string): number | null {
  const s = src.replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  function num(): number | null {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor(): number | null {
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '-') { i++; const v = factor(); return v == null ? null : -v; }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (v == null || peek() !== ')') return null;
      i++;
      return v;
    }
    return num();
  }
  function term(): number | null {
    let v = factor();
    while (v != null && (peek() === '*' || peek() === '/')) {
      const op = s[i++];
      const r = factor();
      if (r == null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number | null {
    let v = term();
    while (v != null && (peek() === '+' || peek() === '-')) {
      const op = s[i++];
      const r = term();
      if (r == null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  if (!s) return null;
  const v = expr();
  return v != null && i === s.length && Number.isFinite(v) ? v : null;
}
