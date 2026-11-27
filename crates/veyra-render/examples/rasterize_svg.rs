//! Rasterise an SVG to a square PNG (used to build the app icon).
//! Usage: cargo run -p veyra-render --example rasterize_svg -- in.svg out.png 1024
use resvg::tiny_skia as sk;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (input, output) = (&a[1], &a[2]);
    let size: u32 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1024);
    let data = std::fs::read(input).expect("read svg");
    let tree = resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).expect("parse svg");
    let ts = tree.size();
    let s = size as f32 / ts.width().max(ts.height());
    let mut pm = sk::Pixmap::new(size, size).unwrap();
    let dx = (size as f32 - ts.width() * s) / 2.0;
    let dy = (size as f32 - ts.height() * s) / 2.0;
    resvg::render(&tree, sk::Transform::from_row(s, 0.0, 0.0, s, dx, dy), &mut pm.as_mut());
    pm.save_png(output).expect("write png");
}
