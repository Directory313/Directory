import { describe, expect, it } from 'vitest';
import { evalArithmetic } from './mathexpr';

describe('number field arithmetic (no eval: blocked by the app CSP)', () => {
  it('parses plain and signed numbers', () => {
    expect(evalArithmetic('55')).toBe(55);
    expect(evalArithmetic(' -12.5 ')).toBe(-12.5);
    expect(evalArithmetic('1e3')).toBe(1000);
    expect(evalArithmetic('.5')).toBe(0.5);
  });
  it('supports + - * / and parentheses with precedence', () => {
    expect(evalArithmetic('100+20')).toBe(120);
    expect(evalArithmetic('2+3*4')).toBe(14);
    expect(evalArithmetic('(2+3)*4')).toBe(20);
    expect(evalArithmetic('10/4')).toBe(2.5);
    expect(evalArithmetic('50*-2')).toBe(-100);
  });
  it('rejects garbage instead of guessing', () => {
    expect(evalArithmetic('abc')).toBeNull();
    expect(evalArithmetic('1+')).toBeNull();
    expect(evalArithmetic('alert(1)')).toBeNull();
    expect(evalArithmetic('1/0')).toBeNull();
  });
});
