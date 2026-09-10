// Cliente JSON-RPC de Odoo con candado de solo lectura.
// Cualquier metodo que escriba queda bloqueado antes de salir a la red.

const SOLO_LECTURA = new Set([
  "search", "search_count", "search_read", "read", "read_group",
  "fields_get", "default_get", "name_search", "name_get"
]);

export class Odoo {
  constructor({ url, db, user, password, permitirEscritura = false }) {
    this.url = url.replace(/\/+$/, "") + "/jsonrpc";
    this.db = db; this.user = user; this.password = password;
    this.permitirEscritura = permitirEscritura;
    this.uid = null;
    this.llamadas = 0;
  }

  async #rpc(service, method, args) {
    this.llamadas++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
    });
    if (!res.ok) throw new Error(`Odoo respondio HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) {
      const m = j.error.data?.message || j.error.message || "error desconocido";
      throw new Error(`Odoo: ${m}`);
    }
    return j.result;
  }

  async conectar() {
    this.uid = await this.#rpc("common", "login", [this.db, this.user, this.password]);
    if (!this.uid) throw new Error("Usuario o contrasena incorrectos.");
    return this.uid;
  }

  // Toda lectura pasa por aqui. El candado es la garantia de que el agente no toca nada.
  async leer(modelo, metodo, args = [], kwargs = {}) {
    if (!this.permitirEscritura && !SOLO_LECTURA.has(metodo)) {
      throw new Error(`BLOQUEADO: "${metodo}" modifica datos. Este agente es de solo lectura.`);
    }
    if (this.uid === null) await this.conectar();
    return this.#rpc("object", "execute_kw", [this.db, this.uid, this.password, modelo, metodo, args, kwargs]);
  }

  // Odoo filtra por compania activa. Sin esto solo se ve una de las 72.
  contextoTodasLasCompanias(ids) {
    return { context: { allowed_company_ids: ids } };
  }
}

export function cargarEnv(texto) {
  const cfg = {};
  for (const linea of texto.split("\n")) {
    const l = linea.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    cfg[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return cfg;
}
