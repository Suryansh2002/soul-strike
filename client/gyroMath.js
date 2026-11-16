const DEG2RAD = Math.PI / 180;
const SQRT1_2 = Math.SQRT1_2;

function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function mulQuat(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function fromEulerYXZ(x, y, z) {
  const c1 = Math.cos(x * 0.5);
  const c2 = Math.cos(y * 0.5);
  const c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5);
  const s2 = Math.sin(y * 0.5);
  const s3 = Math.sin(z * 0.5);

  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}

/**
 * Convert W3C DeviceOrientation angles (degrees) + screen orientation angle
 * into a Three.js world-space camera quaternion (+Y up, -Z camera forward).
 */
export function deviceOrientationToQuat(alphaDeg, betaDeg, gammaDeg, screenOrientDeg = 0) {
  const alpha = (alphaDeg || 0) * DEG2RAD;
  const beta = (betaDeg || 0) * DEG2RAD;
  const gamma = (gammaDeg || 0) * DEG2RAD;
  const orient = (screenOrientDeg || 0) * DEG2RAD;

  // Z-X'-Y'' device angles map to Three.js YXZ(beta, alpha, -gamma)
  let q = fromEulerYXZ(beta, alpha, -gamma);
  // Rotate -90 deg around X so camera looks out the back of the device
  q = mulQuat(q, { x: -SQRT1_2, y: 0, z: 0, w: SQRT1_2 });
  // Compensate for browser screen rotation (0, 90, -90, 180)
  const halfO = -orient * 0.5;
  q = mulQuat(q, { x: 0, y: 0, z: Math.sin(halfO), w: Math.cos(halfO) });
  return q;
}

/**
 * Extract camera-local incremental yaw and pitch deltas (in radians)
 * between two consecutive device camera quaternions.
 */
export function computeGyroDelta(prevQuat, currQuat) {
  if (!prevQuat || !currQuat) return { dYaw: 0, dPitch: 0 };

  const invPrev = {
    x: -prevQuat.x,
    y: -prevQuat.y,
    z: -prevQuat.z,
    w: prevQuat.w,
  };
  const d = mulQuat(invPrev, currQuat);

  // Extract YXZ Euler yaw & pitch from delta quaternion (sign-flip invariant!)
  const dPitch = Math.asin(clampUnit(2 * (d.w * d.x - d.y * d.z)));
  const dYaw = Math.atan2(2 * (d.x * d.z + d.w * d.y), 1 - 2 * (d.x * d.x + d.y * d.y));
  return { dYaw, dPitch };
}
