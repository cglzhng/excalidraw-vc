/**
 * 2D affine transformation matrices, used by the version-log
 * classifier to detect and compare element transformations.
 *
 * Representation matches the canvas / SVG / CSS convention:
 *
 *     ┌                ┐
 *     │  a    c    tx  │
 *     │  b    d    ty  │
 *     │  0    0    1   │
 *     └                ┘
 *
 * Stored as a flat 6-tuple `[a, b, c, d, tx, ty]` — identical to the
 * arguments of `CanvasRenderingContext2D.setTransform` and to
 * `DOMMatrix` / CSS `matrix()`.
 *
 * Point transformation:
 *
 *     ⎡ x' ⎤   ⎡ a  c  tx ⎤ ⎡ x ⎤
 *     ⎢ y' ⎥ = ⎢ b  d  ty ⎥ ⎢ y ⎥
 *     ⎣  1 ⎦   ⎣ 0  0  1  ⎦ ⎣ 1 ⎦
 *
 * giving `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`.
 *
 * Composition: `composeMatrix(A, B)` applies B first, then A — same
 * convention as matrix multiplication and function composition. So
 * `composeMatrix(translationMatrix(10, 0), rotationMatrix(Math.PI/2))`
 * rotates first, then translates.
 */

/**
 * A 2D affine transformation as `[a, b, c, d, tx, ty]`.
 * Branded so it can't be confused with a plain `number[]`.
 */
export type TransformMatrix = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
] & { _brand: "versionLog__transformMatrix" };

/**
 * Default tolerance for float-comparing matrices. Tuned for typical
 * canvas-coord magnitudes (single-digit to low-thousands of pixels).
 * Override via the `epsilon` parameter when needed.
 */
export const DEFAULT_MATRIX_EPSILON = 1e-9;

// ---------------------------- constructors --------------------------

/**
 * Construct a matrix from its six components. Prefer the named
 * constructors below (`translationMatrix`, `rotationMatrix`, ...) when
 * applicable.
 */
export const matrixFrom = (
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
): TransformMatrix => [a, b, c, d, tx, ty] as unknown as TransformMatrix;

/** The identity transformation — leaves every point unchanged. */
export const identityMatrix = (): TransformMatrix =>
  matrixFrom(1, 0, 0, 1, 0, 0);

/** Pure translation by `(dx, dy)`. */
export const translationMatrix = (dx: number, dy: number): TransformMatrix =>
  matrixFrom(1, 0, 0, 1, dx, dy);

/**
 * Rotation by `angle` radians, counter-clockwise about the origin.
 * Matches Excalidraw's `pointRotateRads` direction.
 */
export const rotationMatrix = (angle: number): TransformMatrix => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return matrixFrom(cos, sin, -sin, cos, 0, 0);
};

/**
 * Rotation by `angle` radians about an arbitrary pivot `(cx, cy)`.
 * Equivalent to `translate(cx, cy) · rotate(angle) · translate(-cx, -cy)`.
 */
export const rotationAroundMatrix = (
  angle: number,
  cx: number,
  cy: number,
): TransformMatrix => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return matrixFrom(
    cos,
    sin,
    -sin,
    cos,
    cx - cx * cos + cy * sin,
    cy - cx * sin - cy * cos,
  );
};

/** Uniform or non-uniform scale about the origin. */
export const scaleMatrix = (sx: number, sy: number = sx): TransformMatrix =>
  matrixFrom(sx, 0, 0, sy, 0, 0);

/** Scale about an arbitrary pivot `(cx, cy)`. */
export const scaleAroundMatrix = (
  sx: number,
  sy: number,
  cx: number,
  cy: number,
): TransformMatrix => matrixFrom(sx, 0, 0, sy, cx - cx * sx, cy - cy * sy);

// ---------------------------- algebra -------------------------------

/**
 * Multiply matrices. `composeMatrix(A, B)` applies B first, then A —
 * same convention as `f∘g` in math and function composition.
 *
 * For chaining more than two, pass them all: `composeMatrix(A, B, C)`
 * == `A · B · C`, i.e. C runs first.
 */
export const composeMatrix = (
  first: TransformMatrix,
  ...rest: TransformMatrix[]
): TransformMatrix => {
  let acc = first;
  for (const m of rest) {
    const [a1, b1, c1, d1, tx1, ty1] = acc;
    const [a2, b2, c2, d2, tx2, ty2] = m;
    acc = matrixFrom(
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * tx2 + c1 * ty2 + tx1,
      b1 * tx2 + d1 * ty2 + ty1,
    );
  }
  return acc;
};

/**
 * The matrix that undoes `m`. Returns `null` for singular matrices
 * (zero determinant — e.g. a degenerate scale-to-zero).
 */
export const inverseMatrix = (m: TransformMatrix): TransformMatrix | null => {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (det === 0) {
    return null;
  }
  const invDet = 1 / det;
  return matrixFrom(
    d * invDet,
    -b * invDet,
    -c * invDet,
    a * invDet,
    (c * ty - d * tx) * invDet,
    (b * tx - a * ty) * invDet,
  );
};

// ---------------------------- element box ---------------------------

/**
 * The "element → world" transform: maps the unit square `[0, 1]²`
 * onto the element's footprint in world space. Encodes position
 * (`x`, `y`), size (`width`, `height`), and rotation (`angle` in
 * radians, applied about the element's center).
 *
 * Use this to derive a single matrix representing the geometric change
 * to an element between two states:
 *
 *     M_change = composeMatrix(
 *       elementBoxMatrix(x2, y2, w2, h2, a2),
 *       inverseMatrix(elementBoxMatrix(x1, y1, w1, h1, a1))!,
 *     );
 *
 * `M_change` is then a pure translation for a move, a pure rotation
 * for a rotate-in-place, etc. — and crucially, it's the *same* matrix
 * for every element in a group that received the same operation.
 *
 * Note: the matrix is singular (non-invertible) when `width` or
 * `height` is zero. Callers that need its inverse should check
 * `inverseMatrix(...) !== null`.
 */
export const elementBoxMatrix = (
  x: number,
  y: number,
  width: number,
  height: number,
  angle: number,
): TransformMatrix => {
  const cx = x + width / 2;
  const cy = y + height / 2;
  return composeMatrix(
    rotationAroundMatrix(angle, cx, cy),
    translationMatrix(x, y),
    scaleMatrix(width, height),
  );
};

// ---------------------------- application ---------------------------

/** Apply a transform to a point. */
export const applyMatrixToPoint = (
  m: TransformMatrix,
  point: readonly [number, number],
): [number, number] => {
  const [a, b, c, d, tx, ty] = m;
  const [x, y] = point;
  return [a * x + c * y + tx, b * x + d * y + ty];
};

// ---------------------------- equality ------------------------------

/**
 * Component-wise equality within `epsilon`. Use this rather than `===`
 * — any matrix derived from a rotation will carry floating-point error.
 */
export const matricesEqual = (
  a: TransformMatrix,
  b: TransformMatrix,
  epsilon: number = DEFAULT_MATRIX_EPSILON,
): boolean => {
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a[i] - b[i]) > epsilon) {
      return false;
    }
  }
  return true;
};

/**
 * True if `m` is (within tolerance) the identity. Cheaper than
 * `matricesEqual(m, identityMatrix())` and the most common probe.
 */
export const isIdentityMatrix = (
  m: TransformMatrix,
  epsilon: number = DEFAULT_MATRIX_EPSILON,
): boolean =>
  Math.abs(m[0] - 1) <= epsilon &&
  Math.abs(m[1]) <= epsilon &&
  Math.abs(m[2]) <= epsilon &&
  Math.abs(m[3] - 1) <= epsilon &&
  Math.abs(m[4]) <= epsilon &&
  Math.abs(m[5]) <= epsilon;

// ---------------------------- inspection ----------------------------

/**
 * The point that `m` leaves unchanged, i.e. solves `M · p = p`. For a
 * rotation matrix this is the rotation center; for a scale matrix it
 * is the anchor (the un-moved corner of a corner-drag resize).
 *
 * Returns `null` when the fixed point is not unique:
 *   - pure translation: every point moves, none is fixed,
 *   - identity: every point is fixed (no single answer).
 */
export const fixedPoint = (
  m: TransformMatrix,
  epsilon: number = DEFAULT_MATRIX_EPSILON,
): readonly [number, number] | null => {
  const [a, b, c, d, tx, ty] = m;
  // Fixed point solves
  //   (a - 1) x + c y     = -tx
  //   b x     + (d - 1) y = -ty
  const det = (a - 1) * (d - 1) - b * c;
  if (Math.abs(det) <= epsilon) {
    return null;
  }
  const x = (c * ty - tx * (d - 1)) / det;
  const y = (b * tx - (a - 1) * ty) / det;
  return [x, y];
};

/**
 * The translation component of the matrix as `[tx, ty]`. Cheap — no
 * decomposition, just reads the last two cells.
 */
export const getMatrixTranslation = (
  m: TransformMatrix,
): readonly [number, number] => [m[4], m[5]];

/**
 * True iff `m` is a pure translation (linear part is the identity).
 * Useful for the "did it just move?" classifier check.
 */
export const isPureTranslation = (
  m: TransformMatrix,
  epsilon: number = DEFAULT_MATRIX_EPSILON,
): boolean =>
  Math.abs(m[0] - 1) <= epsilon &&
  Math.abs(m[1]) <= epsilon &&
  Math.abs(m[2]) <= epsilon &&
  Math.abs(m[3] - 1) <= epsilon;

/**
 * Decompose a matrix into translation + rotation + scale, assuming the
 * matrix was built from those three components (no shear). Suitable for
 * matrices the classifier produces from element deltas; not robust for
 * arbitrary affine maps.
 *
 * `rotation` is in radians in `(-π, π]`. `scale` may have negative
 * components when the matrix includes a reflection.
 */
export const decomposeMatrix = (
  m: TransformMatrix,
): {
  translation: readonly [number, number];
  rotation: number;
  scale: readonly [number, number];
} => {
  const [a, b, c, d, tx, ty] = m;
  // Length of the first column == sx; second column == sy
  // (sign of sy carries any reflection — see below).
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  // Mirror correction: if the determinant is negative, the basis is
  // reflected — fold that sign into sy by convention.
  const det = a * d - b * c;
  const sySigned = det < 0 ? -sy : sy;
  // Rotation: angle of the first column.
  const rotation = sx === 0 ? 0 : Math.atan2(b, a);
  return {
    translation: [tx, ty],
    rotation,
    scale: [sx, sySigned],
  };
};
