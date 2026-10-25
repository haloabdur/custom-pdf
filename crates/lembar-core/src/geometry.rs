/// A PDF transformation matrix `[a b c d e f]`, applied to row vectors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix(pub [f32; 6]);

impl Matrix {
    pub const IDENTITY: Matrix = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    /// `self × other`: first apply `self`, then `other`.
    pub fn then(self, other: Matrix) -> Matrix {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = other.0;
        Matrix([
            a1 * a2 + b1 * c2,
            a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2,
            c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2,
            e1 * b2 + f1 * d2 + f2,
        ])
    }

    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        let [a, b, c, d, e, f] = self.0;
        (x * a + y * c + e, x * b + y * d + f)
    }

    /// Axis-aligned bounds of the unit square under this matrix — the box an
    /// image occupies on the page.
    pub fn unit_square_bounds(&self) -> [f32; 4] {
        let pts = [self.apply(0.0, 0.0), self.apply(1.0, 0.0), self.apply(0.0, 1.0), self.apply(1.0, 1.0)];
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for (x, y) in pts {
            b[0] = b[0].min(x);
            b[1] = b[1].min(y);
            b[2] = b[2].max(x);
            b[3] = b[3].max(y);
        }
        b
    }

    /// Lengths of the transformed unit vectors: the drawn width and height.
    pub fn scale(&self) -> (f32, f32) {
        let [a, b, c, d, ..] = self.0;
        ((a * a + b * b).sqrt(), (c * c + d * d).sqrt())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composes_scale_then_translate() {
        let m = Matrix([2.0, 0.0, 0.0, 3.0, 0.0, 0.0]).then(Matrix([1.0, 0.0, 0.0, 1.0, 10.0, 20.0]));
        assert_eq!(m.apply(1.0, 1.0), (12.0, 23.0));
        assert_eq!(m.unit_square_bounds(), [10.0, 20.0, 12.0, 23.0]);
    }
}
