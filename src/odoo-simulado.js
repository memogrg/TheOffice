// Un Odoo de mentira para probar los agentes sin red ni credenciales.
//
// Se alimenta con un JSON { "modelo": [registros...] } (ver test/simulado/instancia.json)
// y responde search_read / read_group / search_count sobre esos registros con la
// porción del lenguaje de dominios de Odoo que usan los agentes:
//   =, !=, in, not in, >, >=, <, <=, ilike, =?  — y los many2one como [id, nombre].
//
// Tiene la misma interfaz que src/odoo.js (leer / escribir / leerTodo / conectar).
// Las escrituras se guardan en `this.cambios` para poder verificarlas en los tests.

export class OdooSimulado {
  constructor(datos, { permitirEscritura = false } = {}) {
    if (!datos || typeof datos !== "object") throw new Error("ODOO_SIMULADO: el archivo no existe o no es un JSON de { modelo: [registros] }.");
    this.datos = datos;
    TABLAS = datos;
    this.permitirEscritura = permitirEscritura;
    this.uid = 1;
    this.llamadas = 0;
    this.escrituras = 0;
    this.cambios = [];
  }

  async conectar() { this.llamadas++; return this.uid; }

  #tabla(modelo) {
    const t = this.datos[modelo];
    if (!t) throw new Error(`Odoo simulado: no hay registros para el modelo "${modelo}" en el archivo.`);
    return t;
  }

  async leer(modelo, metodo, args = [], kwargs = {}) {
    this.llamadas++;
    const t = this.#tabla(modelo);
    if (metodo === "search_read") {
      const [dominio = [], campos = []] = args;
      let filas = t.filter(r => cumple(r, dominio));
      if (kwargs.order) ordenar(filas, kwargs.order);
      if (kwargs.offset) filas = filas.slice(kwargs.offset);
      if (kwargs.limit) filas = filas.slice(0, kwargs.limit);
      return filas.map(r => proyectar(r, campos));
    }
    if (metodo === "search_count") return t.filter(r => cumple(r, args[0] || [])).length;
    if (metodo === "read_group") {
      const [dominio = [], campos = [], agrupar = []] = args;
      const filas = t.filter(r => cumple(r, dominio));
      const grupos = new Map();
      for (const r of filas) {
        const llave = agrupar.map(g => JSON.stringify(valorDeGrupo(r[g]))).join("|");
        if (!grupos.has(llave)) {
          const g = { __count: 0, __domain: [] };
          for (const campo of agrupar) g[campo] = r[campo] ?? false;
          grupos.set(llave, g);
        }
        const g = grupos.get(llave);
        g.__count++;
        for (const c of campos) {
          const m = c.match(/^(\w+):(max|min|sum|count)$/);
          if (!m) continue;
          const [, campo, fn] = m;
          const v = r[campo];
          if (fn === "max") g[campo] = (g[campo] == null || v > g[campo]) ? v : g[campo];
          else if (fn === "min") g[campo] = (g[campo] == null || v < g[campo]) ? v : g[campo];
          else if (fn === "sum") g[campo] = (g[campo] || 0) + (v || 0);
          else if (fn === "count") g[campo] = (g[campo] || 0) + 1;
        }
      }
      return [...grupos.values()];
    }
    throw new Error(`Odoo simulado: método de lectura "${metodo}" no implementado.`);
  }

  async escribir(modelo, metodo, args = [], kwargs = {}) {
    if (!this.permitirEscritura) throw new Error(`BLOQUEADO: "${metodo}" modifica datos y este agente es de solo lectura.`);
    this.llamadas++; this.escrituras++;
    this.cambios.push({ modelo, metodo, args, kwargs });
    const t = this.#tabla(modelo);
    if (metodo === "write") {
      const [ids, valores] = args;
      for (const r of t) if (ids.includes(r.id)) Object.assign(r, this.#normalizar(valores));
      return true;
    }
    if (metodo === "button_draft") { for (const r of t) if (args[0].includes(r.id)) r.state = "draft"; return true; }
    if (metodo === "action_post") {
      for (const r of t) if (args[0].includes(r.id)) r.state = "posted";
      if (modelo === "account.move") for (const l of this.datos["account.move.line"] || []) if (args[0].includes(idDe(l.move_id))) l.parent_state = "posted";
      return true;
    }
    if (metodo === "create") {
      const id = Math.max(0, ...t.map(r => r.id)) + 1;
      const { line_ids, ...valores } = args[0];
      // Como Odoo: un asiento nace en borrador, con nombre, y sus líneas quedan en account.move.line.
      const reg = { id, ...this.#normalizar(valores) };
      if (modelo === "account.move") {
        reg.state = reg.state || "draft"; reg.name = reg.name || `MISC/${id}`;
        const lineas = (this.datos["account.move.line"] = this.datos["account.move.line"] || []);
        for (const [, , l] of line_ids || []) {
          const lid = Math.max(0, ...lineas.map(r => r.id)) + 1;
          lineas.push({ id: lid, ...this.#normalizar(l), move_id: [id, reg.name], company_id: reg.company_id, journal_id: reg.journal_id, date: reg.date,
            parent_state: "draft", balance: (l.debit || 0) - (l.credit || 0) });
        }
      }
      t.push(reg);
      return id;
    }
    if (metodo === "unlink") { const ids = args[0]; this.datos[modelo] = t.filter(r => !ids.includes(r.id)); return true; }
    return true;
  }

  // Odoo devuelve los many2one como [id, nombre]; al escribir se manda solo el id.
  // Para que lo que se relee se vea como en Odoo, se completa el nombre.
  #normalizar(valores) {
    const MODELO_DE = { account_id: "account.account", partner_id: "res.partner", company_id: "res.company", move_id: "account.move" };
    const out = { ...valores };
    for (const [campo, modelo] of Object.entries(MODELO_DE)) {
      if (typeof out[campo] !== "number") continue;
      const reg = (this.datos[modelo] || []).find(r => r.id === out[campo]);
      const nombre = !reg ? String(out[campo]) : modelo === "account.account" ? `${reg.code} ${reg.name}` : reg.name;
      out[campo] = [out[campo], nombre];
    }
    return out;
  }

  async leerTodo(modelo, dominio, campos, { order = "id asc", context } = {}) {
    const filas = await this.leer(modelo, "search_read", [dominio, campos], { order, context });
    return filas;
  }

  contextoTodasLasCompanias(ids) { return { context: { allowed_company_ids: ids } }; }
}

// --- lenguaje de dominios (lo justo) ---
const idDe = v => (Array.isArray(v) ? v[0] : v);
const valorDeGrupo = v => (Array.isArray(v) ? v[0] : v);

export function cumple(r, dominio) {
  // Dominios en notación polaca con "&", "|", "!" opcionales; por defecto todo es AND.
  const pila = [];
  const terminos = [...dominio].reverse();
  for (const t of terminos) {
    if (t === "&") { const a = pila.pop(), b = pila.pop(); pila.push(a && b); }
    else if (t === "|") { const a = pila.pop(), b = pila.pop(); pila.push(a || b); }
    else if (t === "!") { pila.push(!pila.pop()); }
    else pila.push(termino(r, t));
  }
  return pila.every(Boolean);
}

let TABLAS = null; // se fija por instancia para resolver "move_id.move_type"
const MODELO_DE_CAMPO = { move_id: "account.move", account_id: "account.account", partner_id: "res.partner", company_id: "res.company" };

function termino(r, [campo, op, valor]) {
  let crudo;
  if (campo.includes(".")) {
    const [rel, ...resto] = campo.split(".");
    const id = idDe(r[rel]);
    const tabla = TABLAS && TABLAS[MODELO_DE_CAMPO[rel]];
    const reg = tabla ? tabla.find(x => x.id === id) : null;
    crudo = reg ? resto.reduce((o, k) => (o == null ? o : o[k]), reg) : undefined;
  } else crudo = r[campo];
  const v = idDe(crudo);
  const vacio = v === undefined || v === null || v === false || v === "";
  switch (op) {
    case "=": case "==": return valor === false ? vacio : v === valor;
    case "!=": return valor === false ? !vacio : v !== valor;
    case "in": return (Array.isArray(crudo) && !Array.isArray(valor[0]) ? crudo : [v]).some(x => valor.includes(x));
    case "not in": return !valor.includes(v);
    case ">": return v > valor;
    case ">=": return v >= valor;
    case "<": return v < valor;
    case "<=": return v <= valor;
    case "ilike": return String(v ?? "").toLowerCase().includes(String(valor).toLowerCase());
    case "=ilike": return String(v ?? "").toLowerCase() === String(valor).toLowerCase();
    case "like": return String(v ?? "").includes(String(valor));
    case "=?": return valor === false || valor == null ? true : v === valor;
    default: throw new Error(`Odoo simulado: operador "${op}" no implementado.`);
  }
}

function proyectar(r, campos) {
  if (!campos || !campos.length) return { ...r };
  const out = { id: r.id };
  for (const c of campos) out[c] = r[c] === undefined ? false : r[c];
  return out;
}

function ordenar(filas, order) {
  const claves = order.split(",").map(s => s.trim().split(/\s+/)).map(([c, d]) => [c, (d || "asc").toLowerCase() === "desc" ? -1 : 1]);
  filas.sort((a, b) => {
    for (const [c, d] of claves) {
      const x = idDe(a[c]) ?? "", y = idDe(b[c]) ?? "";
      if (x < y) return -d;
      if (x > y) return d;
    }
    return 0;
  });
}
