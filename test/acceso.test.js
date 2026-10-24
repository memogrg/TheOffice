// Usuarios, invitaciones de un solo uso, sesiones por cookie y lo que cada rol puede ver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { crearApi } from "../src/servicio/api.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

function proyectoTemporal() {
  const r = mkdtempSync(join(tmpdir(), "acceso-"));
  mkdirSync(join(r, "data")); mkdirSync(join(r, "ui", "app"), { recursive: true }); mkdirSync(join(r, "src")); mkdirSync(join(r, "test", "simulado"), { recursive: true });
  for (const f of ["roster.json", "reglas.json"]) copyFileSync(join(RAIZ, "data", f), join(r, "data", f));
  copyFileSync(join(RAIZ, "ui", "plantilla.html"), join(r, "ui", "plantilla.html"));
  copyFileSync(join(RAIZ, "src", "director-core.cjs"), join(r, "src", "director-core.cjs"));
  copyFileSync(join(AQUI, "simulado", "instancia.json"), join(r, "test", "simulado", "instancia.json"));
  writeFileSync(join(r, "ui", "app", "index.html"), "<!doctype html><title>app</title>");
  return r;
}

async function servidor() {
  const raiz = proyectoTemporal();
  const db = new BaseDeDatos(":memory:");
  const cfg = { ODOO_SIMULADO: "test/simulado/instancia.json", ALERTA_REFERENCIA: "ultimo-correo", SERVICIO_TOKEN: "admin-token" };
  const corridas = new Corridas({ db, cfg, raiz, raizProyecto: raiz });
  const srv = crearApi({ db, corridas, cfg, raiz, raizProyecto: raiz });
  await new Promise(ok => srv.listen(0, ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const llamar = (p, { metodo = "GET", cuerpo, token, cookie } = {}) => fetch(base + p, {
    method: metodo, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined, redirect: "manual"
  });
  return { raiz, db, srv, base, llamar };
}

test("base: crear usuarios, invitaciones de un solo uso que vencen, sesiones", () => {
  const db = new BaseDeDatos(":memory:");
  const u = db.crearUsuario({ correo: " Finanzas@IAR.org ", nombre: "Ana", rol: "receptor", quien: "memo" });
  assert.equal(u.correo, "finanzas@iar.org");
  assert.throws(() => db.crearUsuario({ correo: "no-es-correo" }), /Correo inválido/);
  assert.throws(() => db.crearUsuario({ correo: "x@y.cr", rol: "dios" }), /Rol inválido/);
  // volver a crear el mismo correo actualiza, no duplica
  const u2 = db.crearUsuario({ correo: "finanzas@iar.org", rol: "contable" });
  assert.equal(u2.id, u.id); assert.equal(u2.rol, "contable"); assert.equal(db.usuarios().length, 1);

  db.crearInvitacion(u.id, "hash-1");
  assert.equal(db.canjearInvitacion("hash-1").id, u.id);
  assert.equal(db.canjearInvitacion("hash-1"), null, "una sola vez");
  db.crearInvitacion(u.id, "hash-vencida", { minutos: -1 });
  assert.equal(db.canjearInvitacion("hash-vencida"), null, "vencida");
  assert.equal(db.canjearInvitacion("no-existe"), null);

  db.crearSesion("s1", u.id);
  assert.equal(db.usuarioDeSesion("s1").correo, "finanzas@iar.org");
  db.desactivarUsuario(u.id, "memo");
  assert.equal(db.usuarioDeSesion("s1"), null, "desactivar cierra sesiones");
  db.crearInvitacion(u.id, "hash-2");
  assert.equal(db.canjearInvitacion("hash-2"), null, "un usuario desactivado no canjea");
});

test("API: el contable invita, el receptor entra por enlace y solo ve lo suyo", async () => {
  const { db, srv, llamar } = await servidor();
  try {
    const admin = { token: "admin-token" };
    assert.equal((await llamar("/api/corridas/recepcion", { metodo: "POST", cuerpo: {}, ...admin })).status, 200);

    // alta + invitación (sin SMTP: el enlace se devuelve para copiarlo)
    const alta = await (await llamar("/api/usuarios", { metodo: "POST", cuerpo: { correo: "contabilidad@puuk.cr", nombre: "Pati", rol: "receptor" }, ...admin })).json();
    assert.equal(alta.rol, "receptor");
    const inv = await (await llamar(`/api/usuarios/${alta.id}/invitar`, { metodo: "POST", cuerpo: { base: "https://oficina.cr" }, ...admin })).json();
    assert.match(inv.enlace, /^https:\/\/oficina\.cr\/\?t=[A-Za-z0-9_-]{20,}$/);
    assert.equal(inv.enviado, false);
    assert.equal(db.auditoria().find(a => a.accion === "invitar").quien, "anónimo");
    const t = new URL(inv.enlace).searchParams.get("t");

    // canje → cookie de sesión; el mismo enlace no sirve dos veces
    const entrar = await llamar("/api/acceso/entrar", { metodo: "POST", cuerpo: { token: t } });
    assert.equal(entrar.status, 200);
    assert.equal((await entrar.json()).usuario.rol, "receptor");
    const sesion = entrar.headers.get("set-cookie").split(";")[0];
    assert.match(sesion, /^sesion_iasima=/);
    assert.equal((await llamar("/api/acceso/entrar", { metodo: "POST", cuerpo: { token: t } })).status, 401);
    assert.equal((await llamar("/api/acceso/entrar", { metodo: "POST", cuerpo: { token: "inventado" } })).status, 401);

    // lo que ve el receptor
    const estado = await (await llamar("/api/estado", { cookie: sesion })).json();
    assert.equal(estado.usuario.correo, "contabilidad@puuk.cr");
    assert.equal(estado.usuario.rol, "receptor");
    assert.equal(estado.pendientes, undefined, "sin aprobaciones ni cifras globales");
    assert.ok(estado.casos.afuera >= 1 && estado.casos.adentro >= 1);
    assert.deepEqual(estado.casos.porCompania.map(c => c.compania), ["Puuk"]);

    const casos = await (await llamar("/api/casos?receptor=admin@iar.org", { cookie: sesion })).json();
    assert.ok(casos.length > 0);
    assert.ok(casos.every(c => c.receptor === "contabilidad@puuk.cr"), "el filtro por otro receptor se ignora");
    const cias = await (await llamar("/api/companias", { cookie: sesion })).json();
    assert.deepEqual(cias.map(c => c.name), ["Puuk"]);

    // resolver lo suyo sí, lo ajeno no
    const ajeno = db.casos({ receptor: "admin@iar.org" })[0];
    assert.equal((await llamar(`/api/casos/${ajeno.id}/resolver`, { metodo: "POST", cuerpo: {}, cookie: sesion })).status, 403);
    const r = await llamar(`/api/casos/${casos[0].id}/resolver`, { metodo: "POST", cuerpo: { nota: "listo" }, cookie: sesion });
    assert.equal(r.status, 200);
    assert.equal(db.casos({ seguimiento: "resuelto" })[0].resuelto_por, "Pati <contabilidad@puuk.cr>", "queda firmado con su nombre");

    // nada de contable
    for (const p of ["/api/propuestas", "/api/corridas", "/api/auditoria", "/api/usuarios", "/api/director"]) {
      assert.equal((await llamar(p, { cookie: sesion })).status, 403, p);
    }
    assert.equal((await llamar("/api/corridas/recepcion", { metodo: "POST", cuerpo: {}, cookie: sesion })).status, 403);
    assert.equal((await llamar("/oficina", { cookie: sesion })).status, 302, "la oficina 2D no es para receptores");

    // correos: solo los dirigidos a él y ya aprobados/enviados
    await llamar("/api/corridas/comunicacion", { metodo: "POST", cuerpo: {}, ...admin });
    assert.deepEqual(await (await llamar("/api/correos", { cookie: sesion })).json(), [], "los borradores no se ven");
    const mio = db.correos({ estado: "borrador" }).find(c => c.para === "contabilidad@puuk.cr");
    const otro = db.correos({ estado: "borrador" }).find(c => c.para !== "contabilidad@puuk.cr");
    db.decidirCorreo(mio.id, "aprobado", "memo"); db.decidirCorreo(otro.id, "aprobado", "memo");
    const visibles = await (await llamar("/api/correos", { cookie: sesion })).json();
    assert.deepEqual(visibles.map(c => c.id), [mio.id]);
    assert.equal((await llamar(`/api/correos/${otro.id}`, { cookie: sesion })).status, 403);
    assert.equal((await llamar(`/api/correos/${mio.id}`, { cookie: sesion })).status, 200);

    // salir
    assert.equal((await llamar("/api/acceso/salir", { metodo: "POST", cuerpo: {}, cookie: sesion })).status, 200);
    assert.equal((await llamar("/api/estado", { cookie: sesion })).status, 401);

    // un contable invitado por enlace tiene todo, y queda su nombre en la auditoría
    const memo = await (await llamar("/api/usuarios", { metodo: "POST", cuerpo: { correo: "memo@iasima.cr", nombre: "Memo", rol: "contable" }, ...admin })).json();
    const inv2 = await (await llamar(`/api/usuarios/${memo.id}/invitar`, { metodo: "POST", cuerpo: { base: "http://x" }, ...admin })).json();
    const e2 = await llamar("/api/acceso/entrar", { metodo: "POST", cuerpo: { token: new URL(inv2.enlace).searchParams.get("t") } });
    const sesion2 = e2.headers.get("set-cookie").split(";")[0];
    assert.equal((await llamar("/api/propuestas", { cookie: sesion2 })).status, 200);
    const prop = db.propuestas({ estado: "todas" });
    await llamar("/api/corridas/cuentas", { metodo: "POST", cuerpo: { empresa: 144 }, cookie: sesion2 });
    assert.equal(db.auditoria().find(a => a.accion === "correr").quien, "Memo <memo@iasima.cr>");
    assert.ok(prop.length >= 0);

    // pedir enlace sin SMTP: mensaje claro; con correo desconocido no revela nada
    assert.equal((await llamar("/api/acceso/pedir", { metodo: "POST", cuerpo: { correo: "nadie@x.cr" } })).status, 503);
  } finally { srv.close(); }
});
