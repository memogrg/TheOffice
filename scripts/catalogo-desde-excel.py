#!/usr/bin/env python3
"""Arma data/catalogo-cuentas.json (el historial del agente Cuentas) desde el Excel
«Artículos por cuenta de gasto» (hoja Detalle: cliente, código, cuenta, tipo, artículo, veces, monto).

Es la alternativa a `npm run catalogo` (que lo arma leyendo Odoo) cuando se tiene el Excel.
El resultado tiene nombres de clientes: queda en data/, que NO se sube al repositorio.

    python3 scripts/catalogo-desde-excel.py Articulos_por_cuenta_de_gasto.xlsx data/catalogo-cuentas.json

Formato (el mismo que lee src/catalogo.js):
  porCliente[CLIENTE][ARTICULO] = [codigo, cuenta, veces]   la cuenta más usada por ese cliente
  global[ARTICULO]              = [codigo, cuenta, veces]   la cuenta más usada sumando todos
CLIENTE y ARTICULO van normalizados como norm() de src/catalogo.js.
"""
import collections, datetime, json, re, sys, unicodedata
import openpyxl

def norm(s):
    s = str(s or "").replace("�", " ")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).upper()
    s = re.sub(r"\[[^\]]*\]", " ", s)
    return re.sub(r"[^A-Z0-9]+", " ", s).strip()

def main(origen, destino):
    wb = openpyxl.load_workbook(origen, read_only=True, data_only=True)
    filas = list(wb["Detalle"].iter_rows(values_only=True))[1:]
    por_cliente = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    por_art = collections.defaultdict(collections.Counter)
    nombres = {}
    lineas = 0
    for cliente, codigo, cuenta, _tipo, articulo, veces, _monto in filas:
        a, c = norm(articulo), norm(cliente)
        if not a or not c or not codigo:
            continue
        v = int(veces or 0)
        lineas += v
        por_cliente[c][a][codigo] += v
        por_art[a][codigo] += v
        nombres.setdefault(codigo, collections.Counter())[cuenta] += v
    cuenta = {k: n.most_common(1)[0][0] for k, n in nombres.items()}
    salida = {
        "_comentario": f"Histórico desde el Excel «Artículos por cuenta de gasto» ({len(filas)} combinaciones, {lineas} líneas). "
                       "Registra lo que se hizo, no lo que es correcto: la guía de clasificación lo usa como referencia (paso 2); "
                       "las decisiones humanas van en reglas.json.",
        "construido": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "fuente": "excel",
        "lineas": lineas,
        "cuentas": cuenta,
        "porCliente": {c: {a: [cnt.most_common(1)[0][0], cuenta[cnt.most_common(1)[0][0]], cnt.most_common(1)[0][1]]
                           for a, cnt in arts.items()} for c, arts in por_cliente.items()},
        "global": {a: [cnt.most_common(1)[0][0], cuenta[cnt.most_common(1)[0][0]], cnt.most_common(1)[0][1]] for a, cnt in por_art.items()},
    }
    json.dump(salida, open(destino, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    n_art = sum(len(v) for v in salida["porCliente"].values())
    print(f"{len(salida['porCliente'])} clientes, {n_art} pares cliente+artículo, {len(salida['global'])} artículos, {len(cuenta)} cuentas → {destino}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
