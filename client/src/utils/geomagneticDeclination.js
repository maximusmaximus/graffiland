/**
 * Lightweight zero-dependency World Magnetic Model (WMM-2025, degree 6) estimator
 * for converting Magnetic North compass headings (Android `AbsoluteOrientationSensor`
 * / `deviceorientationabsolute`) to True Geographic North.
 *
 * Positive declination = Magnetic North is East of True North (e.g., ~+13° in California).
 * Negative declination = Magnetic North is West of True North (e.g., ~-13° in New York).
 */

// WMM-2025 Schmidt semi-normalized Gauss coefficients (nT, epoch 2025.0) up to degree 6
const WMM_EPOCH = 2025.0;
const MAX_DEGREE = 6;

// [n, m, g, h, dg/yr, dh/yr]
const WMM_COEFFS = [
  [1, 0, -29351.8, 0.0, 12.0, 0.0],
  [1, 1, -1410.8, 4545.4, 9.7, -21.5],
  [2, 0, -2556.6, 0.0, -11.6, 0.0],
  [2, 1, 2951.1, -3133.6, -5.2, -27.7],
  [2, 2, 1649.3, -815.1, -8.0, -25.3],
  [3, 0, 1361.0, 0.0, -1.3, 0.0],
  [3, 1, -2404.1, -56.6, -4.2, 4.0],
  [3, 2, 1243.8, 237.5, 0.4, -0.6],
  [3, 3, 453.6, -549.5, -15.6, -4.1],
  [4, 0, 895.0, 0.0, -1.6, 0.0],
  [4, 1, 799.5, 278.6, -2.4, -1.1],
  [4, 2, 55.7, -133.9, -6.0, 4.1],
  [4, 3, -281.1, 212.0, 5.6, 1.6],
  [4, 4, 12.1, -375.6, -7.0, -4.4],
  [5, 0, -233.2, 0.0, 0.6, 0.0],
  [5, 1, 368.9, 45.4, 1.4, -0.5],
  [5, 2, 187.2, 220.2, 0.0, 2.2],
  [5, 3, -138.7, -122.9, 0.6, 0.4],
  [5, 4, -142.0, 43.0, 2.2, 1.7],
  [5, 5, 20.9, 106.1, 0.9, 1.9],
  [6, 0, 64.4, 0.0, -0.2, 0.0],
  [6, 1, 63.8, -18.4, -0.4, 0.3],
  [6, 2, 76.9, 16.8, 0.9, -1.6],
  [6, 3, -115.7, 48.8, 1.2, -0.4],
  [6, 4, -40.9, -59.8, -0.9, 0.9],
  [6, 5, 14.9, 10.9, 0.3, 0.7],
  [6, 6, -60.7, 72.7, 0.9, 0.9]
];

/**
 * Computes Schmidt semi-normalized associated Legendre functions P_n^m(cos(theta))
 * and their derivatives dP_n^m / d(theta) for colatitude theta (radians).
 */
function computeSchmidtLegendre(theta) {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  const P = Array.from({ length: MAX_DEGREE + 1 }, () => new Float64Array(MAX_DEGREE + 1));
  const dP = Array.from({ length: MAX_DEGREE + 1 }, () => new Float64Array(MAX_DEGREE + 1));

  P[0][0] = 1.0;
  dP[0][0] = 0.0;

  // Compute unnormalized first then apply Schmidt factor cleanly
  const Pnorm = Array.from({ length: MAX_DEGREE + 1 }, () => new Float64Array(MAX_DEGREE + 1));
  const dPnorm = Array.from({ length: MAX_DEGREE + 1 }, () => new Float64Array(MAX_DEGREE + 1));
  Pnorm[0][0] = 1.0;

  for (let n = 1; n <= MAX_DEGREE; n += 1) {
    for (let m = 0; m <= n; m += 1) {
      if (n === m) {
        Pnorm[n][m] = sinT * Pnorm[n - 1][m - 1];
        dPnorm[n][m] = sinT * dPnorm[n - 1][m - 1] + cosT * Pnorm[n - 1][m - 1];
      } else if (n === 1 && m === 0) {
        Pnorm[1][0] = cosT * Pnorm[0][0];
        dPnorm[1][0] = cosT * dPnorm[0][0] - sinT * Pnorm[0][0];
      } else {
        const k = n > 1 ? ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
        Pnorm[n][m] = cosT * Pnorm[n - 1][m] - k * Pnorm[n - 2][m];
        dPnorm[n][m] = cosT * dPnorm[n - 1][m] - sinT * Pnorm[n - 1][m] - k * dPnorm[n - 2][m];
      }
    }
  }

  // Convert Gaussian-normalized Pnorm to Schmidt quasi-normalized P
  // S[n][m] satisfies S[0][0]=1, S[n][0] = S[n-1][0]*(2n-1)/n, S[n][m] = S[n][m-1]*sqrt((n-m+1)*(m===1?2:1)/(n+m))
  const S = Array.from({ length: MAX_DEGREE + 1 }, () => new Float64Array(MAX_DEGREE + 1));
  S[0][0] = 1.0;
  for (let n = 1; n <= MAX_DEGREE; n += 1) {
    S[n][0] = (S[n - 1][0] * (2 * n - 1)) / n;
    P[n][0] = Pnorm[n][0] * S[n][0];
    dP[n][0] = dPnorm[n][0] * S[n][0];
    for (let m = 1; m <= n; m += 1) {
      S[n][m] = S[n][m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
      P[n][m] = Pnorm[n][m] * S[n][m];
      dP[n][m] = dPnorm[n][m] * S[n][m];
    }
  }

  return { P, dP };
}

/**
 * Estimates magnetic declination in degrees (positive East, negative West)
 * at geographic `(lat, lng)` for `date`. Returns `0` for invalid coordinates.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Date} [date]
 * @returns {number}
 */
export function estimateMagneticDeclinationDeg(lat, lng, date = new Date()) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return 0;

  const clampedLat = Math.max(-89.5, Math.min(89.5, nLat));
  const year =
    date instanceof Date && Number.isFinite(date.getTime())
      ? date.getUTCFullYear() + date.getUTCMonth() / 12
      : WMM_EPOCH;
  const dt = Math.max(-2, Math.min(8, year - WMM_EPOCH));

  const phi = (clampedLat * Math.PI) / 180;
  const lambda = (nLng * Math.PI) / 180;
  const theta = Math.PI / 2 - phi; // colatitude
  const sinT = Math.max(1e-6, Math.sin(theta));

  const { P, dP } = computeSchmidtLegendre(theta);

  // Horizontal field components at Earth's surface (a / r = 1):
  // X (North) = -dV/d(theta) = sum (g cos m*lam + h sin m*lam) * dP_n^m / d(theta) ... wait:
  // V = a * sum_{n,m} (g cos m*lam + h sin m*lam) * P_n^m(cos theta)
  // B_north = (1/a) * dV/d(theta) -> Wait: B = -grad(V); North is -theta direction:
  // B_theta = -(1/r) * dV/d(theta) (Southward), so B_north = -B_theta = +(1/a) * dV/d(theta)
  // B_east  = -(1/(r sin theta)) * dV/d(lambda)
  let bNorth = 0;
  let bEast = 0;

  for (let i = 0; i < WMM_COEFFS.length; i += 1) {
    const [n, m, g0, h0, dg, dh] = WMM_COEFFS[i];
    const g = g0 + dg * dt;
    const h = h0 + dh * dt;
    const cosML = Math.cos(m * lambda);
    const sinML = Math.sin(m * lambda);
    const radial = g * cosML + h * sinML;
    const dRadialDLam = m * (-g * sinML + h * cosML);

    bNorth += radial * dP[n][m];
    bEast -= (dRadialDLam * P[n][m]) / sinT;
  }

  const declRad = Math.atan2(bEast, bNorth);
  const declDeg = (declRad * 180) / Math.PI;
  if (!Number.isFinite(declDeg)) return 0;
  return Number(declDeg.toFixed(2));
}
