// Instancia simulada para la fase 3B (asientos): dos compañías, pagos de salarios por un banco,
// IVA y CCSS sin liquidar, periodos fiscales. La usan test/asientos.test.js y las pruebas de la app.
const C1 = [1, "Compañía Uno"], C2 = [2, "Compañía Dos"];
const VENTA = [1, "IVA 13% ventas"], COMPRA = [2, "IVA 13% compras"];

export function instancia() {
  const cuentas = [
    { id: 101, code: "2.01.026", name: "Salarios por pagar", account_type: "liability_current", company_ids: [1, 2] },
    { id: 102, code: "2.01.022.001", name: "A pagar CCSS", account_type: "liability_current", company_ids: [1, 2] },
    { id: 103, code: "2.01.023.001", name: "IVA por pagar", account_type: "liability_current", company_ids: [1, 2] },
    { id: 104, code: "1.01.012.001", name: "Créditos por IVA 13%", account_type: "asset_current", company_ids: [1, 2] },
    { id: 109, code: "1.01.001.002", name: "Banco Nacional", account_type: "asset_cash", company_ids: [1] },
    { id: 110, code: "1.01.001.003", name: "Banco de Costa Rica", account_type: "asset_cash", company_ids: [1, 2] },
    { id: 111, code: "1.01.001.004", name: "BAC", account_type: "asset_cash", company_ids: [2] },
    { id: 120, code: "5.04.001", name: "Salarios", account_type: "expense", company_ids: [1, 2] }
  ];
  const diarios = [
    { id: 10, name: "Banco Nacional", type: "bank", company_id: C1, default_account_id: [109, "Banco Nacional"] },
    { id: 11, name: "Banco de Costa Rica", type: "bank", company_id: C1, default_account_id: [110, "Banco de Costa Rica"] },
    { id: 12, name: "Operaciones varias", type: "general", company_id: C1, default_account_id: false },
    { id: 20, name: "BCR", type: "bank", company_id: C2, default_account_id: [110, "Banco de Costa Rica"] },
    { id: 21, name: "BAC", type: "bank", company_id: C2, default_account_id: [111, "BAC"] },
    { id: 22, name: "Varios", type: "general", company_id: C2, default_account_id: false }
  ];
  let lid = 0, mid = 0;
  const lineas = [];
  const asiento = (cia, fecha, diario, partidas) => {
    const m = ++mid;
    for (const [cuenta, balance, imp] of partidas) {
      const c = cuentas.find(x => x.id === cuenta);
      lineas.push({ id: ++lid, move_id: [m, `MOV/${m}`], journal_id: [diario.id, diario.name], company_id: cia, account_id: [cuenta, c.name], date: fecha, parent_state: "posted",
        tax_line_id: imp || false, balance, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0 });
    }
  };
  const [bn, bcr, varios1, , , varios2] = diarios;
  // Compañía Uno: los salarios siempre se pagaron por el Banco Nacional; enero quedó sin pagar.
  asiento(C1, "2025-11-30", varios1, [[120, 900000], [101, -900000]]);
  asiento(C1, "2025-12-05", bn, [[101, 900000], [109, -900000]]);
  asiento(C1, "2025-12-31", varios1, [[120, 900000], [101, -900000]]);
  asiento(C1, "2026-01-05", bn, [[101, 900000], [109, -900000]]);
  asiento(C1, "2026-01-31", varios1, [[120, 1000000], [101, -1000000]]);
  asiento(C1, "2026-02-28", varios1, [[120, 1000000], [101, -1000000]]);
  // IVA: enero quedó sin liquidar (100.000 por pagar, 40.000 de crédito); febrero normal.
  asiento(C1, "2026-01-20", varios1, [[103, -100000, VENTA], [110, 100000]]);
  asiento(C1, "2026-01-21", varios1, [[104, 40000, COMPRA], [110, -40000]]);
  asiento(C1, "2026-02-20", varios1, [[103, -130000, VENTA], [110, 130000]]);
  asiento(C1, "2026-02-21", varios1, [[104, 50000, COMPRA], [110, -50000]]);
  // Compañía Dos: CCSS de enero sin pagar, nunca hubo un pago registrado y tiene dos bancos.
  asiento(C2, "2026-01-31", varios2, [[120, 300000], [102, -300000]]);
  asiento(C2, "2026-02-28", varios2, [[120, 300000], [102, -300000]]);
  return {
    "res.company": [{ id: 1, name: "Compañía Uno" }, { id: 2, name: "Compañía Dos" }],
    "account.account": cuentas, "account.journal": diarios, "account.move.line": lineas,
    "account.move": [...new Set(lineas.map(l => l.move_id[0]))].map(id => ({ id, name: `MOV/${id}`, state: "posted", move_type: "entry" })),
    "account.tax": [{ id: 1, name: "IVA 13% ventas", type_tax_use: "sale" }, { id: 2, name: "IVA 13% compras", type_tax_use: "purchase" }],
    "taerp.fiscal.period": [
      { id: 1, company_id: C1, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "open" },
      { id: 2, company_id: C2, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "close" }
    ]
  };
}
