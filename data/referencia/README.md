# Referencia para clasificar cuentas de gasto

Tres archivos que llevan al repositorio lo útil del histórico «Artículos por cuenta de gasto» **sin datos sensibles**. Son el insumo de los pasos 1 y 2 de la guía de clasificación (`docs/guia-clasificacion-cuentas.md`).

| Archivo | Qué es | Paso de la guía |
|---|---|---|
| `naturaleza-del-gasto.json` | Palabras clave por **naturaleza del gasto** (restaurante, electricidad, ferretería…), la cuenta lógica a la que apuntan, tipos de proveedor y señales de **gasto personal** | 1 y 3 |
| `consenso-articulos.json` | Para cada artículo que usan **3 o más clientes**: en qué cuentas lo registran, cuántos clientes y cuántas veces, y si hay **consenso**, está **dividido** o la mayoría lo manda a un **comodín** | 2 |
| `actividad-proveedor.json` | El **tipo de proveedor** a partir de su actividad económica (la del emisor, que viene en el XML y Odoo guarda en la factura de compra): restaurante, supermercado, ferretería, gasolinera, farmacia… y a qué naturaleza apunta. Propuesta, igual que la naturaleza | 1 y 3 |
| `cuentas-puente.json` | Para el agente **Cierre** (no para clasificar): cómo se reconocen por nombre las cuentas puente (salarios, CCSS, IVA, retenciones, renta, transitorias) y en qué plazo se tienen que liquidar. Propuesta | — |
| `cuentas-logicas.json` | Las cuentas de gasto usadas por 3 o más clientes, su nombre canónico, si el código significa **lo mismo en todos los clientes** y la lista de **comodines** prohibidos | 2 y 4 |

## Qué NO está aquí, y por qué

| Dato del Excel | Tratamiento |
|---|---|
| Nombre de la compañía cliente | **Eliminado.** Solo se publica *cuántos* clientes usan cada cuenta |
| Montos acumulados | **Eliminados.** El criterio no depende del monto |
| Artículos que usan 1 o 2 clientes (25.825 de 26.804 artículos distintos) | **Excluidos.** Son los que permiten adivinar a quién pertenecen y no sirven para medir consenso |
| Descripciones con números largos, pólizas, correos o nombres de clientes (167) | **Excluidas** |
| Exámenes de laboratorio y otros datos de salud o personales (6) | **Excluidos** |
| Nombres de cuenta propios de un cliente (marcas, sucursales) | **Reemplazados** por el nombre canónico |

El Excel original queda **fuera del repositorio** (carpeta de contexto del proyecto). El histórico completo de cada cliente no hace falta aquí: el servicio lo reconstruye desde Odoo con `scripts/construir-catalogo.js`.

## Cifras

- Histórico del **09/09/2026**: 75 compañías, 70.914 líneas de compra.
- **806 artículos** publicados en `consenso-articulos.json`: 385 con consenso, 141 divididos y 280 que la mayoría manda a un comodín (señal de que el paso 1, la naturaleza del gasto, tiene que decidir).
- Cubren alrededor del 20 % de las líneas históricas. El resto depende de la naturaleza del gasto y de las reglas propias de cada cliente.

## Dos advertencias

1. **El mismo código no siempre significa lo mismo.** Las cuentas marcadas `"consistente": false` (seguros, suscripciones, costo de ventas, otros honorarios) cambian de significado según el cliente. Para ellas, se resuelve por **nombre de cuenta** en el plan de esa compañía, no por código.
2. **`naturaleza-del-gasto.json` es una propuesta.** Falta la revisión de Victor (contador). No se usa para escribir en Odoo hasta que esté aprobada.

## Cómo regenerar `consenso-articulos.json`

En la máquina donde está el Excel (nunca se sube):

```bash
pip install openpyxl
python3 scripts/generar-referencia.py Articulos_por_cuenta_de_gasto.xlsx data/referencia/consenso-articulos.json
```

El mínimo de clientes (3) está en `MINIMO_CLIENTES` dentro del script. Bajarlo aumenta la cobertura y el riesgo de identificar a un cliente.

## Quién usa estos archivos

`src/clasificador.js` aplica la guía con ellos (lo usan el agente Cuentas y la herramienta `revisar_factura` del Director):
regla propia → naturaleza (línea + tipo de proveedor) → historial (el del cliente, en `data/catalogo-cuentas.json`, y el consenso de aquí) → consulta → no identificado.
Lo que no se cierra solo queda en **Aprobaciones → Consultas al contador**; desde ahí se resuelve con una regla (por artículo o por proveedor).

El historial por cliente (`data/catalogo-cuentas.json`, fuera del repositorio) se arma de dos formas:
`npm run catalogo` (desde Odoo) o, con el Excel, `python3 scripts/catalogo-desde-excel.py Articulos_por_cuenta_de_gasto.xlsx data/catalogo-cuentas.json`.
