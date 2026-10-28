import { test } from "node:test";
import assert from "node:assert/strict";
import { Odoo, cargarEnv, ErrorOdoo } from "../src/odoo.js";
import { OdooSimulado, cumple } from "../src/odoo-simulado.js";

// Un fetch de mentira que responde JSON-RPC y registra lo que recibe.
function fetchFalso(responder) {
  const llamadas = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    llamadas.push(body);
    const r = await responder(body, llamadas.length);
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? { jsonrpc: "2.0", id: body.id, result: r.result } };
  };
  f.llamadas = llamadas;
  return f;
}

test("leer() rechaza métodos de escritura aunque el cliente tenga permiso", async () => {
  const o = new Odoo({ url: "http://x", db: "d", user: "u", password: "p", permitirEscritura: true, fetchImpl: fetchFalso(() => ({ result: 1 })) });
  await assert.rejects(() => o.leer("account.move", "write", [[1], {}]), /BLOQUEADO/);
  await assert.rejects(() => o.leer("account.move", "action_post", [[1]]), /BLOQUEADO/);
});

test("escribir() exige permiso y lo cuenta", async () => {
  const f = fetchFalso(b => ({ result: b.params.method === "login" ? 7 : true }));
  const sin = new Odoo({ url: "http://x/", db: "d", user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => sin.escribir("account.move", "write", [[1], {}]), /solo lectura/);
  const con = new Odoo({ url: "http://x/", db: "d", user: "u", password: "p", permitirEscritura: true, fetchImpl: f });
  assert.equal(await con.escribir("account.move", "write", [[1], { a: 1 }]), true);
  assert.equal(con.escrituras, 1);
  assert.equal(con.uid, 7, "conecta solo antes de la primera llamada");
  assert.equal(f.llamadas[0].params.method, "login");
  assert.equal(f.llamadas[1].params.args[4], "write");
});

test("reintenta errores de red y 5xx, no errores de Odoo", async () => {
  let n = 0;
  const f = fetchFalso((b, i) => {
    if (b.params.method === "login") return { result: 1 };
    n++;
    if (n === 1) return Object.assign(new Error("ECONNRESET"), { name: "FetchError" });
    if (n === 2) return { ok: false, status: 502 };
    return { result: [{ id: 1 }] };
  });
  const o = new Odoo({ url: "http://x", db: "d", user: "u", password: "p", reintentos: 3, fetchImpl: f });
  assert.deepEqual(await o.leer("res.company", "search_read", [[], ["name"]]), [{ id: 1 }]);
  assert.equal(n, 3);

  const g = fetchFalso(b => b.params.method === "login" ? { result: 1 } : { json: { error: { code: 200, message: "Odoo Server Error", data: { message: "Acceso denegado" } } } });
  const p = new Odoo({ url: "http://x", db: "d", user: "u", password: "p", reintentos: 3, fetchImpl: g });
  await assert.rejects(() => p.leer("res.company", "search_read", [[], []]), e => e instanceof ErrorOdoo && /Acceso denegado/.test(e.message) && !e.reintentable);
  assert.equal(g.llamadas.length, 2, "login + una sola lectura, sin reintentos");
});

test("leerTodo() pagina por id y reordena al final", async () => {
  const datos = [5, 3, 9, 1, 7].map(id => ({ id, date: String(10 - id) }));
  const f = fetchFalso(b => {
    if (b.params.method === "login") return { result: 1 };
    const [dom, , , ] = [b.params.args[5][0]];
    const desde = dom[0][2];
    const limit = b.params.args[6].limit;
    return { result: datos.filter(r => r.id > desde).sort((a, b2) => a.id - b2.id).slice(0, limit) };
  });
  const o = new Odoo({ url: "http://x", db: "d", user: "u", password: "p", fetchImpl: f });
  const todo = await o.leerTodo("m", [["x", "=", 1]], ["date"], { paso: 2, order: "date desc" });
  assert.deepEqual(todo.map(r => r.id), [1, 3, 5, 7, 9]);
  assert.equal(f.llamadas.length, 1 + 3, "login + 3 páginas (2+2+1)");
  assert.deepEqual(f.llamadas[1].params.args[5][0], [["id", ">", 0], ["x", "=", 1]]);
});

test("cargarEnv() ignora comentarios y quita comillas", () => {
  const c = cargarEnv('# comentario\nA=1\nB="dos"\nC=\'tres\'\nD=a=b\n\nSIN_IGUAL\n');
  assert.deepEqual(c, { A: "1", B: "dos", C: "tres", D: "a=b" });
});

test("el Odoo simulado entiende los dominios que usan los agentes", () => {
  const r = { id: 1, state: "done", company_id: [144, "Ceiba"], name: "Factura X", vat: "3101" };
  assert.ok(cumple(r, [["state", "=", "done"]]));
  assert.ok(cumple(r, [["state", "!=", "draft"], ["company_id", "=", 144]]));
  assert.ok(cumple(r, [["company_id", "in", [1, 144]]]));
  assert.ok(cumple(r, [["name", "ilike", "factura"]]));
  assert.ok(cumple(r, ["|", ["state", "=", "x"], ["vat", "in", ["3101"]]]));
  assert.ok(!cumple(r, [["state", "in", ["draft", "posted"]]]));
  assert.ok(cumple({ id: 2, e_key: "abc" }, [["e_key", "!=", false]]));
  assert.ok(!cumple({ id: 2, e_key: false }, [["e_key", "!=", false]]));
});

test("el Odoo simulado bloquea escrituras sin permiso y las registra con permiso", async () => {
  const sin = new OdooSimulado({ "account.move": [{ id: 1, state: "posted" }] });
  await assert.rejects(() => sin.escribir("account.move", "button_draft", [[1]]), /BLOQUEADO/);
  const con = new OdooSimulado({ "account.move": [{ id: 1, state: "posted" }] }, { permitirEscritura: true });
  await con.escribir("account.move", "button_draft", [[1]]);
  assert.equal((await con.leer("account.move", "search_read", [[], ["state"]]))[0].state, "draft");
  assert.equal(con.cambios.length, 1);
});
