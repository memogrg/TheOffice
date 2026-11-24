// Salud de la conexión con Odoo, deducida de las corridas: si las últimas corridas terminaron en
// fallo y el error es de acceso (credenciales, red, tiempo de espera), la Oficina lo dice arriba en
// rojo y el Director lo cuenta primero, en vez de fingir que «no hay corridas».
//
// Devuelve { estado: "ok" | "fallo" | "sin-acceso", ... }:
//   ok          la última corrida terminada salió bien (o no hay corridas)
//   fallo       la última falló por otra cosa (un agente con error propio)
//   sin-acceso  la última falló por acceso a Odoo; trae desde cuándo, cuántos intentos seguidos y el error
const ACCESO = /usuario o contrase|contrase[ñn]a incorrect|invalid credentials|access denied|accessdenied|autentic|unauthorized|forbidden|HTTP 40[13]|HTTP 5\d\d|econnrefused|enotfound|etimedout|econnreset|fetch failed|no respondi[oó] en|sin conexi[oó]n con odoo|socket hang up|falta ODOO_URL/i;

export const esErrorDeAcceso = e => ACCESO.test(String(e || ""));

export function saludOdoo(db, { limite = 40 } = {}) {
  const terminadas = db.corridas({ limite }).filter(c => c.estado && c.estado !== "corriendo");
  if (!terminadas.length) return { estado: "ok", corridas: 0 };
  const ultima = terminadas[0];
  if (ultima.estado === "ok") return { estado: "ok", corridas: terminadas.length, ultimaOk: { id: ultima.id, agente: ultima.agente, fin: ultima.fin } };
  // Racha de fallos seguidos desde la última que salió bien
  const racha = [];
  for (const c of terminadas) { if (c.estado === "ok") break; racha.push(c); }
  const primera = racha[racha.length - 1], ultimaOk = terminadas.find(c => c.estado === "ok") || null;
  const porAgente = {};
  for (const c of racha) porAgente[c.agente] = (porAgente[c.agente] || 0) + 1;
  const base = { intentos: racha.length, desde: primera.inicio, ultimo: ultima.fin || ultima.inicio, agente: ultima.agente, corrida: ultima.id, error: String(ultima.error || "").slice(0, 300), porAgente,
    ultimaOk: ultimaOk ? { id: ultimaOk.id, agente: ultimaOk.agente, fin: ultimaOk.fin } : null };
  if (esErrorDeAcceso(ultima.error)) {
    return { estado: "sin-acceso", ...base,
      texto: `Odoo rechaza la conexión desde ${fechaCorta(primera.inicio)} (${racha.length} corrida${racha.length === 1 ? "" : "s"} fallida${racha.length === 1 ? "" : "s"} seguida${racha.length === 1 ? "" : "s"}): ${base.error}`,
      queHacer: "Revisar las credenciales de Odoo del servicio (usuario, contraseña o clave de API) y que la instancia responda. Es tarea de quien administra la Oficina, no del contador." };
  }
  return { estado: "fallo", ...base, texto: `La última corrida (${ultima.agente}, ${fechaCorta(ultima.fin || ultima.inicio)}) falló: ${base.error}` };
}

const fechaCorta = iso => { const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("es-CR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: process.env.TZ || "America/Costa_Rica" }); };
