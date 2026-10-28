// Genera test/simulado/instancia.json: un Odoo pequeño pero con todos los casos que
// los agentes saben manejar. Determinista (sin azar) para que los tests sean estables.
//   node test/simulado/generar.js
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));

// clave de 50 dígitos: país(3) ddmmaa(6) cédula(12) consecutivo(20) situación(1) seguridad(8)
function clave({ fecha = "110326", cedula = "3101123456", tipo = "01", numero = 1 }) {
  const consecutivo = "001" + "00001" + tipo + String(numero).padStart(10, "0");
  return "506" + fecha + cedula.padStart(12, "0") + consecutivo + "1" + "12345678";
}

const companias = [
  { id: 144, name: "Ceiba" },
  { id: 126, name: "Refugio Verde" },
  { id: 82, name: "Lirio" }
];
const cia = id => [id, companias.find(c => c.id === id).name];

const partners = [
  { id: 1, name: "Bodegas del Valle S.A.", vat: "3101123456" },
  { id: 2, name: "Ferretería El Mar", vat: "3101222222" },
  { id: 3, name: "Distribuidora Vega", vat: "3101333333" },
  { id: 4, name: "Ceiba", vat: "3101444444" }
];

let n = 0;
const correos = [];
function correo({ cia: c, estado, tipo = "01", cedula = "3101123456", to = "contabilidad@ceiba.cr", from = '"Bodegas del Valle" <facturas@bodegasdelvalle.cr>', fecha = "2026-03-11 14:00:00", error = "", sinClave = false, numero }) {
  n++;
  const k = sinClave ? null : clave({ tipo, cedula, numero: numero ?? n });
  correos.push({
    id: n, company_id: cia(c), state: estado, to_mail: to, from_mail: from, date: fecha,
    name: k ? `Factura ${k.slice(21, 41)}` : "Documento sin clave legible",
    e_invoice_name: k ? `${k}.xml` : "adjunto.xml",
    error
  });
  return k;
}

// Ceiba: mezcla completa
const kDone1 = correo({ cia: 144, estado: "done", numero: 1 });
const kDone2 = correo({ cia: 144, estado: "done", numero: 2 });
const kDone3 = correo({ cia: 144, estado: "done", cedula: "3101222222", numero: 3 });   // sin asiento en libros
correo({ cia: 144, estado: "done", tipo: "04", numero: 4 });                             // tiquete colado como factura
correo({ cia: 144, estado: "isticket", tipo: "04", numero: 5 });
correo({ cia: 144, estado: "isticket", tipo: "04", numero: 5 });                        // el mismo tiquete, reenviado
correo({ cia: 144, estado: "isticket", tipo: "01", numero: 6 });                        // marcado tiquete pero es factura
correo({ cia: 144, estado: "rejected", cedula: "3101222222", numero: 7 });
correo({ cia: 144, estado: "error", numero: 8, error: "No se puede registrar: el periodo fiscal 2026-02-01 está cerrado" });
correo({ cia: 144, estado: "error", numero: 9, error: "No se puede registrar: el periodo fiscal 2026-03-01 está cerrado" });
correo({ cia: 144, estado: "duplicate", numero: 1 });
correo({ cia: 144, estado: "vatiderror", sinClave: true, from: '"Distribuidora Vega" <ventas@vega.cr>' });
correo({ cia: 144, estado: "process", numero: 10, fecha: "2026-03-11 15:00:00" });
correo({ cia: 144, estado: "rejected", sinClave: true, from: "noreply@hacienda.go.cr", to: "contabilidad@ceiba.cr, gerencia@ceiba.cr" });

// RV: dos receptores, buzón sano
const kRv = correo({ cia: 126, estado: "done", cedula: "3101333333", to: "admin@refugioverde.org", numero: 20 });
correo({ cia: 126, estado: "done", cedula: "3101333333", to: "admin@refugioverde.org", numero: 21 });
correo({ cia: 126, estado: "isticket", tipo: "04", cedula: "3101333333", to: "admin@refugioverde.org; finanzas@refugioverde.org", numero: 22 });

// Lirio: buzón caído (último correo hace semanas) y correo sin receptor
correo({ cia: 82, estado: "done", to: "lirio@lirio.cr", fecha: "2026-02-05 09:00:00", numero: 30 });
correo({ cia: 82, estado: "error", to: "", fecha: "2026-02-05 09:30:00", numero: 31, error: "Proveedor no existe" });

const asientos = [kDone1, kDone2, kRv].map((k, i) => ({
  id: 100 + i, e_key: k, company_id: i < 2 ? cia(144) : cia(126), move_type: "in_invoice", state: "posted"
}));

// Plan de cuentas y facturas de Ceiba para el agente CUENTAS
const cuentas = [
  { id: 500, code: "5.04.002.002", name: "Electricidad", account_type: "expense", deprecated: false, company_ids: [144] },
  { id: 501, code: "5.04.002.001", name: "Agua", account_type: "expense", deprecated: false, company_ids: [144] },
  { id: 502, code: "5.04.999", name: "Gastos generales", account_type: "expense", deprecated: false, company_ids: [144] },
  { id: 503, code: "5.01.001", name: "Costo de ventas", account_type: "expense", deprecated: false, company_ids: [144] },
  { id: 504, code: "2.01.001", name: "Proveedores", account_type: "liability_payable", deprecated: false, company_ids: [144] }
];
const facturas = [
  { id: 900, name: "FAC/2026/001", state: "draft", payment_state: "not_paid", partner_id: [1, "Bodegas del Valle S.A."], invoice_date: "2026-03-01", amount_total: 50000, ref: "", move_type: "in_invoice", company_id: cia(144) },
  { id: 901, name: "FAC/2026/002", state: "posted", payment_state: "not_paid", partner_id: [2, "Ferretería El Mar"], invoice_date: "2026-03-02", amount_total: 80000, ref: "", move_type: "in_invoice", company_id: cia(144) },
  { id: 902, name: "FAC/2026/003", state: "posted", payment_state: "paid", partner_id: [2, "Ferretería El Mar"], invoice_date: "2026-03-03", amount_total: 10000, ref: "", move_type: "in_invoice", company_id: cia(144) }
];
const lineas = [
  // 900 borrador: una línea mal puesta (regla humana), una bien
  { id: 1, move_id: [900, "FAC/2026/001"], name: "TRB-TRIBUTO BOMBEROS", account_id: [503, "5.01.001 Costo de ventas"], product_id: false, display_type: "product", balance: 1200, other_charge_id: false },
  { id: 2, move_id: [900, "FAC/2026/001"], name: "SERVICIO DE AGUA", account_id: [501, "5.04.002.001 Agua"], product_id: false, display_type: "product", balance: 8000, other_charge_id: false },
  { id: 3, move_id: [900, "FAC/2026/001"], name: "Proveedores", account_id: [504, "2.01.001 Proveedores"], product_id: false, display_type: "payment_term", balance: -9200, other_charge_id: false },
  // 901 publicada: cajón de sastre (se corrige) y un artículo que no está en el catálogo
  { id: 4, move_id: [901, "FAC/2026/002"], name: "SERVICIO ELECTRICO", account_id: [502, "5.04.999 Gastos generales"], product_id: false, display_type: "product", balance: 30000, other_charge_id: false },
  { id: 5, move_id: [901, "FAC/2026/002"], name: "TORNILLOS GALVANIZADOS 3/8", account_id: [502, "5.04.999 Gastos generales"], product_id: false, display_type: "product", balance: 5000, other_charge_id: false },
  // 902 pagada: no se toca aunque esté mal
  { id: 6, move_id: [902, "FAC/2026/003"], name: "SERVICIO ELECTRICO", account_id: [502, "5.04.999 Gastos generales"], product_id: false, display_type: "product", balance: 10000, other_charge_id: false }
];

for (const l of lineas) {
  const f = facturas.find(x => x.id === l.move_id[0]);
  l.parent_state = f.state; l.company_id = f.company_id;
}

const instancia = {
  "res.company": companias,
  "res.partner": partners,
  "bdt.invoice.email": correos,
  "account.move": [...asientos, ...facturas],
  "account.account": cuentas,
  "account.move.line": lineas,
  "bdt.other.charge.line": []
};
writeFileSync(join(AQUI, "instancia.json"), JSON.stringify(instancia, null, 2));
console.log(`instancia.json: ${correos.length} correos, ${asientos.length} asientos, ${facturas.length} facturas, ${lineas.length} líneas`);
