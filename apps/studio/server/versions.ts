/** Whether release `a` is newer than `b` (1.2.3, compared number by number; what follows a hyphen is left out). */
export const newer = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
