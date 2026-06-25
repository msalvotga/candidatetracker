/** TX SBOE district benchmark margins (percentage points, R+ / D−). */
const ABBOTT_2022 = [
  -9.12, 4.6, -9.15, -44.83, -30.44, 15.7, 21.09, 19.88, 34.24, 33.98,
  22.66, 21.07, -46.02, 27.87, 60.07,
];

const TRUMP_2024 = [
  0.97, 14.43, -2.28, -34.44, -23.11, 15.99, 21.26, 21.16, 32.72, 32.35,
  22.79, 21.36, -37.23, 27.14, 56.61,
];

const CRUZ_2024 = [
  -5.58, 6.68, -9.01, -40.86, -27.53, 11.13, 16.58, 15.5, 28.39, 28.53,
  17.54, 16.28, -43.65, 22.14, 53.06,
];

export const SBOE_BENCHMARKS = ABBOTT_2022.map((abbott, index) => ({
  district: index + 1,
  trump: TRUMP_2024[index],
  cruz: CRUZ_2024[index],
  abbott,
}));
