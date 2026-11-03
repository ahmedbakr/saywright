export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function minus(n: number): string {
  return `−$${n.toFixed(2)}`;
}
