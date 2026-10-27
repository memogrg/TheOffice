// Meses como texto «AAAA-MM» (sin zonas horarias de por medio).
export const mesDe = f => (f ? String(f).slice(0, 7) : null);
export function sumarMeses(mes, n) {
  const [a, m] = mes.split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export const mesesEntre = (desde, hasta) => {
  const [a1, m1] = desde.split("-").map(Number), [a2, m2] = hasta.split("-").map(Number);
  return (a2 * 12 + m2) - (a1 * 12 + m1);
};
export const hoyLocal = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Costa_Rica" });
export const mediana = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
