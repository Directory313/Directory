//! VEYRA core: project model, universal animation engine, expressions, transforms,
//! effect registry and project persistence. No GPU, no media I/O — pure, testable logic.

pub mod anim;
pub mod eval;
pub mod expr;
pub mod factory;
pub mod interop;
pub mod io;
pub mod model;
pub mod ops;
pub mod registry;

pub use anim::*;
pub use model::*;
