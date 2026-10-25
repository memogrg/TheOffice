#!/usr/bin/env python3
"""Genera data/referencia/consenso-articulos.json a partir del histórico
«Artículos por cuenta de gasto» (Excel exportado de Odoo).

El Excel NO va en el repositorio: tiene nombres de clientes y montos.
Se corre en la máquina donde está el Excel:

    python3 scripts/generar-referencia.py Articulos_por_cuenta_de_gasto.xlsx data/referencia/consenso-articulos.json

Qué hace (y qué deja fuera):
  · Normaliza la descripción del artículo igual que norm() de src/catalogo.js.
  · Solo publica artículos que usan 3 o más clientes distintos (MINIMO_CLIENTES).
  · No publica nombres de clientes ni montos: solo cuántos clientes y cuántas veces por cuenta.
  · Descarta descripciones con números largos, pólizas, correos, nombres de clientes o datos de salud.
  · Marca cada artículo: consenso (≥ 2/3 de sus clientes en la misma cuenta), dividido,
    o comodin-mayoritario (la mayoría lo manda a 7.01.01 / 5.04.99 / 5.04.999).
"""
import collections, json, re, sys, unicodedata
import openpyxl

MINIMO_CLIENTES = 3
COMODIN = {"7.01.01", "5.04.99", "5.04.999", "0.1"}
SENSIBLE = re.compile(r"\d{6,}|POLIZA|@|\bWWW\b|\bCEDULA\b|\bCONTABILIDAD\s?MES\b|\bTEL\b")
SALUD = re.compile(r"HEMOGRAMA|ACIDO URICO|LIPIDOS|FUNCION RENAL|KOTEX|RECETA")
GENERICAS = set("SOCIEDAD ANONIMA LIMITADA RESPONSABILIDAD COSTA RICA SERVICIOS GRUPO COMPANY INTERNATIONAL "
                "INVERSIONES CORPORACION COMERCIAL DESARROLLO ASOCIADOS CONSULTORES TRADING HOLDING EMPRESA "
                "NACIONAL CENTRAL SOLUCIONES PROFESIONALES ADMINISTRACION GLOBAL".split())

def norm(s):
    s = str(s or "").replace("�", " ")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).upper()
    s = re.sub(r"\[[^\]]*\]", " ", s)
    return re.sub(r"[^A-Z0-9]+", " ", s).strip()

def main(origen, destino):
    wb = openpyxl.load_workbook(origen, read_only=True, data_only=True)
    filas = list(wb["Detalle"].iter_rows(values_only=True))[1:]
    clientes = {r[0] for r in filas}
    tokens_clientes = {t for c in clientes for t in norm(c).split()
                       if len(t) >= 5 and not t.isdigit() and t not in GENERICAS}

    art = collections.defaultdict(lambda: collections.defaultdict(lambda: {"clientes": set(), "veces": 0}))
    for cliente, codigo, _cuenta, _tipo, desc, veces, _monto in filas:
        k = norm(desc)
        if k:
            e = art[k][codigo]; e["clientes"].add(cliente); e["veces"] += veces or 0

    salida, excluidos = [], collections.Counter()
    for k, por_codigo in art.items():
        sus_clientes = set().union(*[v["clientes"] for v in por_codigo.values()])
        if len(sus_clientes) < MINIMO_CLIENTES: excluidos["menos de 3 clientes"] += 1; continue
        if SENSIBLE.search(k): excluidos["patron sensible"] += 1; continue
        if any(t in tokens_clientes for t in k.split()): excluidos["contiene nombre de cliente"] += 1; continue
        if SALUD.search(k): excluidos["dato de salud o personal"] += 1; continue
        dist = sorted(((c, len(v["clientes"]), v["veces"]) for c, v in por_codigo.items()),
                      key=lambda x: (-x[1], -x[2]))
        top = dist[0]
        if top[0] in COMODIN: estado = "comodin-mayoritario"
        elif top[1] >= MINIMO_CLIENTES and top[1] / len(sus_clientes) >= 2 / 3: estado = "consenso"
        else: estado = "dividido"
        salida.append({"articulo": k, "clientes": len(sus_clientes), "estado": estado,
                       "cuentas": [[c, n, v] for c, n, v in dist]})
    salida.sort(key=lambda f: (-f["clientes"], f["articulo"]))
    json.dump({"filas": salida, "excluidos": excluidos, "clientes_total": len(clientes)},
              open(destino, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(salida)} artículos publicados; excluidos: {dict(excluidos)}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
