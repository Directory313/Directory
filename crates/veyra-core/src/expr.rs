//! VEYRA expression language: a small, sandboxed, side-effect-free language for procedural
//! animation. Expressions cannot perform I/O, loop unboundedly or allocate without limit.
//!
//! ```text
//! let base = value;            // statements separated by ';', last expression is the result
//! base + [wiggle(2, 30)[0], 0, 0]
//! time * 360                    // numbers, vectors [a, b, c], + - * / % ^, comparisons, ?:
//! loopOut("cycle")              // repeat keyframes
//! layer("Null 1", "position")   // another layer's keyframed value (expressions not followed)
//! ```

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Num(f64),
    Vec(Vec<f64>),
    Str(String),
}

impl Val {
    pub fn components(&self) -> Vec<f64> {
        match self {
            Val::Num(n) => vec![*n],
            Val::Vec(v) => v.clone(),
            Val::Str(_) => vec![],
        }
    }
    fn num(&self) -> Result<f64, String> {
        match self {
            Val::Num(n) => Ok(*n),
            Val::Vec(v) if v.len() == 1 => Ok(v[0]),
            Val::Vec(_) => Err("expected a number, got a vector".into()),
            Val::Str(_) => Err("expected a number, got a string".into()),
        }
    }
    fn truthy(&self) -> bool {
        match self {
            Val::Num(n) => *n != 0.0,
            Val::Vec(v) => v.iter().any(|x| *x != 0.0),
            Val::Str(s) => !s.is_empty(),
        }
    }
}

/// Host callbacks the expression may query.
pub trait ExprHost {
    /// Keyframed value of the current property at another time (used by loopOut/valueAt).
    fn value_at(&self, t: f64) -> Vec<f64>;
    /// First and last keyframe times, if any.
    fn key_range(&self) -> Option<(f64, f64)>;
    /// Keyframed value of a property on another layer in the same composition.
    fn layer_prop(&self, layer: &str, prop: &str, t: f64) -> Option<Vec<f64>>;
}

pub struct ExprEnv<'a> {
    pub time: f64,
    pub value: Vec<f64>,
    pub fps: f64,
    pub index: f64,
    pub duration: f64,
    pub comp_width: f64,
    pub comp_height: f64,
    /// Stable per-layer/property seed so wiggle/random differ between properties.
    pub seed: u64,
    pub host: &'a dyn ExprHost,
}

// ------------------------------------------------------------------ lexer

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Str(String),
    Op(&'static str),
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let ops = [
        "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", "[", "]", ",", "<", ">", "?", ":", "!", ";", "=",
    ];
    let b = src.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i] as char;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && i + 1 < b.len() && (b[i + 1] as char).is_ascii_digit()) {
            let s = i;
            while i < b.len() && ((b[i] as char).is_ascii_digit() || b[i] == b'.') {
                i += 1;
            }
            if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
                i += 1;
                if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
                    i += 1;
                }
                while i < b.len() && (b[i] as char).is_ascii_digit() {
                    i += 1;
                }
            }
            out.push(Tok::Num(src[s..i].parse().map_err(|_| format!("bad number '{}'", &src[s..i]))?));
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' {
            let s = i;
            while i < b.len() && ((b[i] as char).is_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] == b'.') {
                i += 1;
            }
            out.push(Tok::Ident(src[s..i].to_string()));
            continue;
        }
        if c == '"' || c == '\'' {
            let q = b[i];
            i += 1;
            let s = i;
            while i < b.len() && b[i] != q {
                i += 1;
            }
            if i >= b.len() {
                return Err("unterminated string".into());
            }
            out.push(Tok::Str(src[s..i].to_string()));
            i += 1;
            continue;
        }
        match ops.iter().find(|o| src[i..].starts_with(**o)) {
            Some(o) => {
                out.push(Tok::Op(o));
                i += o.len();
            }
            None => return Err(format!("unexpected character '{c}'")),
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ parser (to AST)

#[derive(Debug, Clone)]
enum Ast {
    Num(f64),
    Str(String),
    Var(String),
    Vec(Vec<Ast>),
    Index(Box<Ast>, Box<Ast>),
    Unary(&'static str, Box<Ast>),
    Bin(&'static str, Box<Ast>, Box<Ast>),
    Tern(Box<Ast>, Box<Ast>, Box<Ast>),
    Call(String, Vec<Ast>),
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn eat(&mut self, op: &str) -> bool {
        if let Some(Tok::Op(o)) = self.peek() {
            if *o == op {
                self.pos += 1;
                return true;
            }
        }
        false
    }
    fn expect(&mut self, op: &str) -> Result<(), String> {
        if self.eat(op) { Ok(()) } else { Err(format!("expected '{op}'")) }
    }
    fn expr(&mut self) -> Result<Ast, String> {
        self.depth += 1;
        if self.depth > 64 {
            return Err("expression nested too deeply".into());
        }
        let r = self.ternary();
        self.depth -= 1;
        r
    }
    fn ternary(&mut self) -> Result<Ast, String> {
        let c = self.binary(0)?;
        if self.eat("?") {
            let a = self.expr()?;
            self.expect(":")?;
            let b = self.expr()?;
            return Ok(Ast::Tern(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn binary(&mut self, min_prec: u8) -> Result<Ast, String> {
        let mut lhs = self.unary()?;
        loop {
            let (op, prec, right) = match self.peek() {
                Some(Tok::Op(o)) => match *o {
                    "||" => ("||", 1, false),
                    "&&" => ("&&", 2, false),
                    "==" | "!=" => (*o, 3, false),
                    "<" | ">" | "<=" | ">=" => (*o, 4, false),
                    "+" | "-" => (*o, 5, false),
                    "*" | "/" | "%" => (*o, 6, false),
                    "^" => ("^", 7, true),
                    _ => break,
                },
                _ => break,
            };
            if prec < min_prec {
                break;
            }
            self.pos += 1;
            let rhs = self.binary(if right { prec } else { prec + 1 })?;
            lhs = Ast::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn unary(&mut self) -> Result<Ast, String> {
        if self.eat("-") {
            return Ok(Ast::Unary("-", Box::new(self.unary()?)));
        }
        if self.eat("!") {
            return Ok(Ast::Unary("!", Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return self.unary();
        }
        self.postfix()
    }
    fn postfix(&mut self) -> Result<Ast, String> {
        let mut a = self.primary()?;
        while self.eat("[") {
            let i = self.expr()?;
            self.expect("]")?;
            a = Ast::Index(Box::new(a), Box::new(i));
        }
        Ok(a)
    }
    fn primary(&mut self) -> Result<Ast, String> {
        match self.peek().cloned() {
            Some(Tok::Num(n)) => {
                self.pos += 1;
                Ok(Ast::Num(n))
            }
            Some(Tok::Str(s)) => {
                self.pos += 1;
                Ok(Ast::Str(s))
            }
            Some(Tok::Ident(name)) => {
                self.pos += 1;
                if self.eat("(") {
                    let mut args = Vec::new();
                    if !self.eat(")") {
                        loop {
                            args.push(self.expr()?);
                            if self.eat(")") {
                                break;
                            }
                            self.expect(",")?;
                        }
                    }
                    Ok(Ast::Call(name, args))
                } else {
                    Ok(Ast::Var(name))
                }
            }
            Some(Tok::Op("(")) => {
                self.pos += 1;
                let e = self.expr()?;
                self.expect(")")?;
                Ok(e)
            }
            Some(Tok::Op("[")) => {
                self.pos += 1;
                let mut items = Vec::new();
                if !self.eat("]") {
                    loop {
                        items.push(self.expr()?);
                        if self.eat("]") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                Ok(Ast::Vec(items))
            }
            Some(t) => Err(format!("unexpected token {t:?}")),
            None => Err("unexpected end of expression".into()),
        }
    }
}

/// A parsed program: `let` bindings followed by a result expression.
#[derive(Debug, Clone)]
pub struct Program {
    lets: Vec<(String, Ast)>,
    result: Ast,
}

pub fn parse(src: &str) -> Result<Program, String> {
    if src.len() > 8192 {
        return Err("expression too long (max 8 KB)".into());
    }
    let toks = lex(src)?;
    let mut p = Parser { toks, pos: 0, depth: 0 };
    let mut lets = Vec::new();
    loop {
        if let Some(Tok::Ident(k)) = p.peek() {
            if k == "let" || k == "var" || k == "const" {
                p.pos += 1;
                let name = match p.peek().cloned() {
                    Some(Tok::Ident(n)) => n,
                    _ => return Err("expected a name after 'let'".into()),
                };
                p.pos += 1;
                p.expect("=")?;
                let e = p.expr()?;
                p.expect(";")?;
                lets.push((name, e));
                continue;
            }
        }
        break;
    }
    let result = p.expr()?;
    while p.eat(";") {}
    if p.pos != p.toks.len() {
        return Err(format!("unexpected trailing input near token {}", p.pos));
    }
    Ok(Program { lets, result })
}

// ------------------------------------------------------------------ evaluator

fn hash32(mut x: u64) -> f64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51afd7ed558ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ceb9fe1a85ec53);
    x ^= x >> 33;
    (x & 0xFFFF_FFFF) as f64 / u32::MAX as f64
}

/// Smooth 1D value noise in -1..1.
pub fn noise1(x: f64, seed: u64) -> f64 {
    let i = x.floor();
    let f = x - i;
    let a = hash32(seed ^ (i as i64 as u64).wrapping_mul(0x9E3779B97F4A7C15)) * 2.0 - 1.0;
    let b = hash32(seed ^ ((i + 1.0) as i64 as u64).wrapping_mul(0x9E3779B97F4A7C15)) * 2.0 - 1.0;
    let s = f * f * (3.0 - 2.0 * f);
    a + (b - a) * s
}

/// After-Effects-style wiggle offset for component `c`.
pub fn wiggle(freq: f64, amp: f64, octaves: u32, t: f64, seed: u64, c: usize) -> f64 {
    let mut sum = 0.0;
    let (mut f, mut a, mut norm) = (freq, 1.0, 0.0);
    for o in 0..octaves.clamp(1, 8) {
        sum += noise1(t * f, seed.wrapping_add((c as u64) * 7919 + o as u64 * 104729)) * a;
        norm += a;
        f *= 2.0;
        a *= 0.5;
    }
    sum / norm * amp
}

fn zip(a: Val, b: Val, f: impl Fn(f64, f64) -> f64) -> Result<Val, String> {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => Ok(Val::Num(f(x, y))),
        (Val::Vec(x), Val::Num(y)) => Ok(Val::Vec(x.into_iter().map(|v| f(v, y)).collect())),
        (Val::Num(x), Val::Vec(y)) => Ok(Val::Vec(y.into_iter().map(|v| f(x, v)).collect())),
        (Val::Vec(x), Val::Vec(y)) => {
            let n = x.len().max(y.len());
            Ok(Val::Vec((0..n).map(|i| f(*x.get(i).unwrap_or(&0.0), *y.get(i).unwrap_or(&0.0))).collect()))
        }
        _ => Err("cannot do arithmetic on strings".into()),
    }
}

struct Eval<'a, 'b> {
    env: &'a ExprEnv<'b>,
    vars: HashMap<String, Val>,
    steps: usize,
}

impl Eval<'_, '_> {
    fn ev(&mut self, a: &Ast) -> Result<Val, String> {
        self.steps += 1;
        if self.steps > 100_000 {
            return Err("expression exceeded its evaluation budget".into());
        }
        Ok(match a {
            Ast::Num(n) => Val::Num(*n),
            Ast::Str(s) => Val::Str(s.clone()),
            Ast::Var(n) => self.var(n)?,
            Ast::Vec(items) => {
                let mut v = Vec::with_capacity(items.len());
                for i in items {
                    v.extend(self.ev(i)?.components());
                }
                Val::Vec(v)
            }
            Ast::Index(a, i) => {
                let v = self.ev(a)?.components();
                let i = self.ev(i)?.num()? as isize;
                Val::Num(*v.get(i.max(0) as usize).ok_or_else(|| format!("index {i} out of range"))?)
            }
            Ast::Unary(op, x) => {
                let v = self.ev(x)?;
                match *op {
                    "-" => zip(Val::Num(0.0), v, |a, b| a - b)?,
                    _ => Val::Num(if v.truthy() { 0.0 } else { 1.0 }),
                }
            }
            Ast::Tern(c, a, b) => {
                if self.ev(c)?.truthy() { self.ev(a)? } else { self.ev(b)? }
            }
            Ast::Bin(op, l, r) => {
                if *op == "&&" {
                    let lv = self.ev(l)?;
                    return Ok(if !lv.truthy() { Val::Num(0.0) } else { Val::Num(self.ev(r)?.truthy() as i32 as f64) });
                }
                if *op == "||" {
                    let lv = self.ev(l)?;
                    return Ok(if lv.truthy() { Val::Num(1.0) } else { Val::Num(self.ev(r)?.truthy() as i32 as f64) });
                }
                let (lv, rv) = (self.ev(l)?, self.ev(r)?);
                let b = |x: bool| if x { 1.0 } else { 0.0 };
                match *op {
                    "+" => zip(lv, rv, |a, b| a + b)?,
                    "-" => zip(lv, rv, |a, b| a - b)?,
                    "*" => zip(lv, rv, |a, b| a * b)?,
                    "/" => zip(lv, rv, |a, b| if b == 0.0 { 0.0 } else { a / b })?,
                    "%" => zip(lv, rv, |a, b| if b == 0.0 { 0.0 } else { a.rem_euclid(b) })?,
                    "^" => zip(lv, rv, f64::powf)?,
                    "==" => Val::Num(b(lv == rv)),
                    "!=" => Val::Num(b(lv != rv)),
                    "<" => Val::Num(b(lv.num()? < rv.num()?)),
                    ">" => Val::Num(b(lv.num()? > rv.num()?)),
                    "<=" => Val::Num(b(lv.num()? <= rv.num()?)),
                    ">=" => Val::Num(b(lv.num()? >= rv.num()?)),
                    _ => return Err(format!("unknown operator {op}")),
                }
            }
            Ast::Call(name, args) => self.call(name, args)?,
        })
    }

    fn var(&self, n: &str) -> Result<Val, String> {
        if let Some(v) = self.vars.get(n) {
            return Ok(v.clone());
        }
        let e = self.env;
        let value = || if e.value.len() == 1 { Val::Num(e.value[0]) } else { Val::Vec(e.value.clone()) };
        Ok(match n {
            "time" | "t" => Val::Num(e.time),
            "value" => value(),
            "frame" => Val::Num((e.time * e.fps).floor()),
            "fps" => Val::Num(e.fps),
            "index" => Val::Num(e.index),
            "duration" => Val::Num(e.duration),
            "width" | "thisComp.width" => Val::Num(e.comp_width),
            "height" | "thisComp.height" => Val::Num(e.comp_height),
            "PI" | "Math.PI" => Val::Num(std::f64::consts::PI),
            "E" | "Math.E" => Val::Num(std::f64::consts::E),
            "true" => Val::Num(1.0),
            "false" => Val::Num(0.0),
            _ => return Err(format!("unknown name '{n}'")),
        })
    }

    fn call(&mut self, name: &str, args: &[Ast]) -> Result<Val, String> {
        let name = name.strip_prefix("Math.").unwrap_or(name);
        let mut a = Vec::with_capacity(args.len());
        for x in args {
            a.push(self.ev(x)?);
        }
        let n = |i: usize| -> Result<f64, String> { a.get(i).ok_or(format!("{name}: missing argument {}", i + 1))?.num() };
        let unary = |f: fn(f64) -> f64| -> Result<Val, String> {
            match a.first() {
                Some(Val::Vec(v)) => Ok(Val::Vec(v.iter().map(|x| f(*x)).collect())),
                Some(x) => Ok(Val::Num(f(x.num()?))),
                None => Err(format!("{name}: expected an argument")),
            }
        };
        let env = self.env;
        Ok(match name {
            "sin" => unary(f64::sin)?,
            "cos" => unary(f64::cos)?,
            "tan" => unary(f64::tan)?,
            "asin" => unary(f64::asin)?,
            "acos" => unary(f64::acos)?,
            "atan" => unary(f64::atan)?,
            "abs" => unary(f64::abs)?,
            "floor" => unary(f64::floor)?,
            "ceil" => unary(f64::ceil)?,
            "round" => unary(f64::round)?,
            "sqrt" => unary(f64::sqrt)?,
            "exp" => unary(f64::exp)?,
            "log" => unary(f64::ln)?,
            "sign" => unary(f64::signum)?,
            "degreesToRadians" | "rad" => unary(f64::to_radians)?,
            "radiansToDegrees" | "deg" => unary(f64::to_degrees)?,
            "atan2" => Val::Num(n(0)?.atan2(n(1)?)),
            "pow" => Val::Num(n(0)?.powf(n(1)?)),
            "min" => zip(a.first().cloned().ok_or("min: args")?, a.get(1).cloned().ok_or("min: args")?, f64::min)?,
            "max" => zip(a.first().cloned().ok_or("max: args")?, a.get(1).cloned().ok_or("max: args")?, f64::max)?,
            "clamp" => {
                let (lo, hi) = (n(1)?, n(2)?);
                match &a[0] {
                    Val::Vec(v) => Val::Vec(v.iter().map(|x| x.clamp(lo.min(hi), hi.max(lo))).collect()),
                    x => Val::Num(x.num()?.clamp(lo.min(hi), hi.max(lo))),
                }
            }
            "lerp" | "mix" => {
                let t = n(2)?;
                zip(a[0].clone(), a[1].clone(), |x, y| x + (y - x) * t)?
            }
            "length" => {
                let c = a.first().map(|v| v.components()).unwrap_or_default();
                if a.len() >= 2 {
                    let d = a[1].components();
                    Val::Num(c.iter().zip(d.iter()).map(|(x, y)| (x - y) * (x - y)).sum::<f64>().sqrt())
                } else {
                    Val::Num(c.iter().map(|x| x * x).sum::<f64>().sqrt())
                }
            }
            "linear" | "ease" | "easeIn" | "easeOut" => {
                // linear(t, tMin, tMax, v1, v2)
                let (t, t0, t1) = (n(0)?, n(1)?, n(2)?);
                let mut p = if (t1 - t0).abs() < 1e-12 { 1.0 } else { ((t - t0) / (t1 - t0)).clamp(0.0, 1.0) };
                p = match name {
                    "ease" => p * p * (3.0 - 2.0 * p),
                    "easeIn" => p * p,
                    "easeOut" => 1.0 - (1.0 - p) * (1.0 - p),
                    _ => p,
                };
                let v1 = a.get(3).cloned().ok_or("linear: needs 5 arguments")?;
                let v2 = a.get(4).cloned().ok_or("linear: needs 5 arguments")?;
                zip(v1, v2, |x, y| x + (y - x) * p)?
            }
            "random" => {
                // random() 0..1, random(max), random(min, max): stable per frame.
                let r = hash32(env.seed ^ ((env.time * env.fps).floor() as i64 as u64).wrapping_mul(31) ^ self.steps as u64);
                match a.len() {
                    0 => Val::Num(r),
                    1 => Val::Num(r * n(0)?),
                    _ => Val::Num(n(0)? + r * (n(1)? - n(0)?)),
                }
            }
            "noise" => Val::Num(noise1(n(0)?, env.seed)),
            "wiggle" => {
                let (f, amp) = (n(0)?, n(1)?);
                let oct = a.get(2).map(|v| v.num()).transpose()?.unwrap_or(1.0) as u32;
                let t = a.get(3).map(|v| v.num()).transpose()?.unwrap_or(env.time);
                let base = &env.value;
                if base.len() <= 1 {
                    Val::Num(base.first().copied().unwrap_or(0.0) + wiggle(f, amp, oct, t, env.seed, 0))
                } else {
                    Val::Vec(base.iter().enumerate().map(|(c, v)| v + wiggle(f, amp, oct, t, env.seed, c)).collect())
                }
            }
            "valueAtTime" | "valueAt" => to_val(env.host.value_at(n(0)?)),
            "loopOut" | "loopIn" => {
                let mode = match a.first() {
                    Some(Val::Str(s)) => s.clone(),
                    _ => "cycle".into(),
                };
                let Some((k0, k1)) = env.host.key_range() else { return Ok(to_val(env.value.clone())) };
                let span = k1 - k0;
                if span <= 1e-9 {
                    return Ok(to_val(env.value.clone()));
                }
                let t = env.time;
                let outside = if name == "loopOut" { t > k1 } else { t < k0 };
                if !outside {
                    return Ok(to_val(env.value.clone()));
                }
                let rel = (t - k0).rem_euclid(span);
                match mode.as_str() {
                    "pingpong" => {
                        let cycle = ((t - k0) / span).floor() as i64;
                        let lt = if cycle.rem_euclid(2) == 1 { k1 - rel } else { k0 + rel };
                        to_val(env.host.value_at(lt))
                    }
                    "offset" => {
                        let cycles = ((t - k0) / span).floor();
                        let (v0, v1) = (env.host.value_at(k0), env.host.value_at(k1));
                        let v = env.host.value_at(k0 + rel);
                        to_val(v.iter().enumerate().map(|(i, x)| x + (v1[i] - v0[i]) * cycles).collect())
                    }
                    "continue" => {
                        let (va, vb) = (env.host.value_at(k1 - 0.01), env.host.value_at(k1));
                        to_val(vb.iter().enumerate().map(|(i, x)| x + (x - va[i]) / 0.01 * (t - k1)).collect())
                    }
                    _ => to_val(env.host.value_at(k0 + rel)),
                }
            }
            "layer" => {
                let lname = match a.first() {
                    Some(Val::Str(s)) => s.clone(),
                    _ => return Err("layer(name, property) needs a layer name string".into()),
                };
                let prop = match a.get(1) {
                    Some(Val::Str(s)) => s.clone(),
                    _ => "position".into(),
                };
                let t = a.get(2).map(|v| v.num()).transpose()?.unwrap_or(env.time);
                to_val(env.host.layer_prop(&lname, &prop, t).ok_or_else(|| format!("layer '{lname}' or property '{prop}' not found"))?)
            }
            "vec" | "array" => {
                let mut v = vec![];
                for x in &a {
                    v.extend(x.components());
                }
                Val::Vec(v)
            }
            _ => return Err(format!("unknown function '{name}'")),
        })
    }
}

fn to_val(v: Vec<f64>) -> Val {
    if v.len() == 1 { Val::Num(v[0]) } else { Val::Vec(v) }
}

pub fn run(prog: &Program, env: &ExprEnv) -> Result<Vec<f64>, String> {
    let mut e = Eval { env, vars: HashMap::new(), steps: 0 };
    for (n, a) in &prog.lets {
        let v = e.ev(a)?;
        e.vars.insert(n.clone(), v);
    }
    let r = e.ev(&prog.result)?;
    let c = r.components();
    if c.iter().any(|x| !x.is_finite()) {
        return Err("expression produced a non-finite number".into());
    }
    if c.is_empty() {
        return Err("expression must produce a number or vector".into());
    }
    Ok(c)
}

/// Parse-and-run convenience. Parsed programs are cached by the caller where it matters.
pub fn evaluate(src: &str, env: &ExprEnv) -> Result<Vec<f64>, String> {
    run(&parse(src)?, env)
}

/// Validation entry point for the UI: returns an error message or None.
pub fn validate(src: &str) -> Option<String> {
    parse(src).err()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct H;
    impl ExprHost for H {
        fn value_at(&self, t: f64) -> Vec<f64> {
            vec![t * 10.0]
        }
        fn key_range(&self) -> Option<(f64, f64)> {
            Some((0.0, 1.0))
        }
        fn layer_prop(&self, l: &str, _p: &str, _t: f64) -> Option<Vec<f64>> {
            (l == "Null 1").then(|| vec![5.0, 6.0, 0.0])
        }
    }

    fn env(time: f64, value: Vec<f64>) -> ExprEnv<'static> {
        ExprEnv { time, value, fps: 30.0, index: 1.0, duration: 10.0, comp_width: 1920.0, comp_height: 1080.0, seed: 42, host: &H }
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(evaluate("1 + 2 * 3 ^ 2", &env(0.0, vec![0.0])).unwrap(), vec![19.0]);
        assert_eq!(evaluate("(1 + 2) * 3", &env(0.0, vec![0.0])).unwrap(), vec![9.0]);
        assert_eq!(evaluate("-2 ^ 2", &env(0.0, vec![0.0])).unwrap(), vec![4.0]);
    }

    #[test]
    fn vectors_and_variables() {
        let r = evaluate("let a = value; a + [10, 20] * time", &env(2.0, vec![1.0, 1.0])).unwrap();
        assert_eq!(r, vec![21.0, 41.0]);
        assert_eq!(evaluate("value[1]", &env(0.0, vec![3.0, 7.0])).unwrap(), vec![7.0]);
    }

    #[test]
    fn functions_and_ternary() {
        assert_eq!(evaluate("time > 1 ? 100 : 0", &env(2.0, vec![0.0])).unwrap(), vec![100.0]);
        assert_eq!(evaluate("linear(time, 0, 2, 0, 100)", &env(1.0, vec![0.0])).unwrap(), vec![50.0]);
        assert_eq!(evaluate("clamp(500, 0, 255)", &env(0.0, vec![0.0])).unwrap(), vec![255.0]);
        assert_eq!(evaluate("layer('Null 1', 'position')", &env(0.0, vec![0.0])).unwrap(), vec![5.0, 6.0, 0.0]);
    }

    #[test]
    fn wiggle_is_deterministic_and_bounded() {
        let a = evaluate("wiggle(3, 50)", &env(1.234, vec![100.0, 100.0])).unwrap();
        let b = evaluate("wiggle(3, 50)", &env(1.234, vec![100.0, 100.0])).unwrap();
        assert_eq!(a, b);
        assert!(a.iter().all(|v| (*v - 100.0).abs() <= 50.0));
    }

    #[test]
    fn loop_out_cycles() {
        // keys span 0..1, value_at(t) = 10t, so at t=1.5 cycle -> value_at(0.5) = 5
        assert_eq!(evaluate("loopOut('cycle')", &env(1.5, vec![15.0])).unwrap(), vec![5.0]);
        assert_eq!(evaluate("loopOut('pingpong')", &env(1.25, vec![0.0])).unwrap(), vec![7.5]);
    }

    #[test]
    fn errors_are_reported_not_panicked() {
        assert!(evaluate("foo(", &env(0.0, vec![0.0])).is_err());
        assert!(evaluate("unknownVar", &env(0.0, vec![0.0])).is_err());
        assert!(evaluate("'text'", &env(0.0, vec![0.0])).is_err());
        assert!(validate("time * ").is_some());
    }
}
