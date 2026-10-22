// Cliente JSON-RPC de Odoo con candado de solo lectura.
//
// Dos puertas, y solo dos:
//   leer(modelo, metodo, ...)     — acepta únicamente métodos de la lista SOLO_LECTURA.
//                                   Nunca escribe, aunque el cliente tenga permiso.
//   escribir(modelo, metodo, ...) — cualquier método. Exige permitirEscritura = true,
//                                   si no, se rechaza antes de salir a la red.
//
// Así un agente de lectura no puede escribir ni por descuido: tendría que llamar
// escribir() a propósito, y aun así el permiso se lo da run.js según su meta.escribe.

const SOLO_LECTURA = new Set([
  "search", "search_count", "search_read", "read", "read_group",
  "fields_get", "default_get", "name_search", "name_get", "web_search_read"
]);

export class ErrorOdoo extends Error {
  constructor(mensaje, { codigo = null, datos = null, reintentable = false } = {}) {
    super(mensaje);
    this.name = "ErrorOdoo";
    this.codigo = codigo;
    this.datos = datos;
    this.reintentable = reintentable;
  }
}

export class Odoo {
  constructor({ url, db, user, password, permitirEscritura = false, timeoutMs = 60_000, reintentos = 2, fetchImpl = globalThis.fetch }) {
    if (!url) throw new Error("Falta ODOO_URL.");
    this.url = url.replace(/\/+$/, "") + "/jsonrpc";
    this.db = db; this.user = user; this.password = password;
    this.permitirEscritura = permitirEscritura;
    this.timeoutMs = timeoutMs;
    this.reintentos = reintentos;
    this.fetch = fetchImpl;
    this.uid = null;
    this.llamadas = 0;
    this.escrituras = 0;
  }

  async #rpc(service, method, args) {
    this.llamadas++;
    let intento = 0;
    for (;;) {
      try {
        return await this.#rpcUnaVez(service, method, args);
      } catch (e) {
        // Solo se reintenta lo que es de red o de servidor saturado. Un error de
        // Odoo ("no tiene permiso", "registro no existe") no mejora reintentando.
        if (!e.reintentable || intento >= this.reintentos) throw e;
        intento++;
        await new Promise(r => setTimeout(r, 500 * 2 ** intento));
      }
    }
  }

  async #rpcUnaVez(service, method, args) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
        signal: ctrl.signal
      });
    } catch (e) {
      const m = e.name === "AbortError" ? `Odoo no respondió en ${this.timeoutMs / 1000} s` : `Sin conexión con Odoo: ${e.message}`;
      throw new ErrorOdoo(m, { reintentable: true });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ErrorOdoo(`Odoo respondió HTTP ${res.status}`, { codigo: res.status, reintentable: res.status >= 500 || res.status === 429 });
    const j = await res.json();
    if (j.error) {
      const m = j.error.data?.message || j.error.message || "error desconocido";
      throw new ErrorOdoo(`Odoo: ${m}`, { codigo: j.error.code, datos: j.error.data });
    }
    return j.result;
  }

  async conectar() {
    this.uid = await this.#rpc("common", "login", [this.db, this.user, this.password]);
    if (!this.uid) throw new ErrorOdoo("Usuario o contraseña incorrectos.");
    return this.uid;
  }

  async #ejecutar(modelo, metodo, args, kwargs) {
    if (this.uid === null) await this.conectar();
    return this.#rpc("object", "execute_kw", [this.db, this.uid, this.password, modelo, metodo, args, kwargs]);
  }

  // Toda lectura pasa por aquí. Rechaza cualquier método que no sea de lectura,
  // tenga o no permiso de escritura el cliente: esa es la garantía del agente.
  async leer(modelo, metodo, args = [], kwargs = {}) {
    if (!SOLO_LECTURA.has(metodo)) {
      throw new ErrorOdoo(`BLOQUEADO: "${metodo}" no es un método de lectura. Use escribir() si de verdad debe modificar datos.`);
    }
    return this.#ejecutar(modelo, metodo, args, kwargs);
  }

  // Toda escritura pasa por aquí, y solo si el cliente fue creado con permiso.
  async escribir(modelo, metodo, args = [], kwargs = {}) {
    if (!this.permitirEscritura) {
      throw new ErrorOdoo(`BLOQUEADO: "${metodo}" modifica datos y este agente es de solo lectura.`);
    }
    this.escrituras++;
    return this.#ejecutar(modelo, metodo, args, kwargs);
  }

  // search_read completo, paginado, con orden estable (id) para que ninguna página
  // repita ni se salte filas aunque la tabla cambie entre llamadas.
  async leerTodo(modelo, dominio, campos, { paso = 2000, order = "id asc", context, alAvanzar } = {}) {
    const out = [];
    let ultimoId = 0;
    for (;;) {
      const dom = [["id", ">", ultimoId], ...dominio];
      const kwargs = { limit: paso, order: "id asc" };
      if (context) kwargs.context = context;
      const lote = await this.leer(modelo, "search_read", [dom, campos], kwargs);
      out.push(...lote);
      if (lote.length) ultimoId = lote[lote.length - 1].id;
      if (alAvanzar) alAvanzar(out.length);
      if (lote.length < paso) break;
    }
    if (order && order !== "id asc") ordenar(out, order);
    return out;
  }

  // Odoo filtra por compañía activa. Sin esto solo se ve una de todas.
  contextoTodasLasCompanias(ids) {
    return { context: { allowed_company_ids: ids } };
  }
}

// "date desc, name asc" -> ordena en memoria el resultado de leerTodo
function ordenar(filas, order) {
  const claves = order.split(",").map(s => s.trim().split(/\s+/)).map(([c, d]) => [c, (d || "asc").toLowerCase() === "desc" ? -1 : 1]);
  filas.sort((a, b) => {
    for (const [c, d] of claves) {
      const x = a[c] ?? "", y = b[c] ?? "";
      if (x < y) return -d;
      if (x > y) return d;
    }
    return 0;
  });
}

export function cargarEnv(texto) {
  const cfg = {};
  for (const linea of texto.split("\n")) {
    const l = linea.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    cfg[l.slice(0, i).trim()] = v;
  }
  return cfg;
}
