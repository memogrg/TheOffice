# Casillas del paquete 150 → campos del portal

Las casillas son de la Oficina. El formulario 150 de TRIBU-CR se declara **por tarifa** (13 %, 4 %,
2 %, 1 %, 0,5 %, 0 % con derecho, exentas, 0 % sin derecho), con un resumen del crédito fiscal y el
impuesto determinado. **Esta tabla se ajusta en la primera declaración real con el contador**: el
nombre exacto de cada campo del portal se anota en la columna «Campo del portal» y se deja aquí.

| Casilla | Qué es | Campo del portal (ajustar) |
| --- | --- | --- |
| `v13` | Ventas gravadas, tarifa general 13 % (base) | Ventas → Tarifa general 13 % → Monto |
| `v4`, `v2`, `v1`, `v05` | Ventas, tarifas reducidas 4 %, 2 %, 1 %, 0,5 % (base) | Ventas → Tarifa reducida … |
| `vt4`, `vt8` | Ventas, tarifas transitorias 4 % y 8 % | Ventas → Transitorio … |
| `v0cd` | Ventas al 0 % con derecho a crédito (art. 32, exportaciones) | Ventas → Tarifa 0 % con derecho |
| `vex` | Ventas exentas | Ventas → Exentas |
| `v0sd` | Ventas al 0 % sin derecho a crédito | Ventas → 0 % sin derecho |
| `vexo` | Ventas autorizadas sin impuesto: clientes exonerados (zona franca, art. 8). Es la base que llevaba IVA pero no se cobró | Ventas → Autorizadas sin impuesto / Exoneradas (confirmar con el contador en la primera declaración) |
| `dexo` | IVA no cobrado por esas exoneraciones. **Informativo**: no se escribe en el portal | (no se escribe; sirve para explicar por qué el débito es menor) |
| `vtot` | Total de ventas | (lo calcula el portal: solo releer) |
| `d13`, `d4`, … | IVA cobrado por tarifa | (lo calcula el portal desde la base: releer y comparar) |
| `dtot` | Débito fiscal total | (releer) |
| `c13`, `c4`, … | Compras por tarifa (base) | Compras → Tarifa … → Monto |
| `s13`, `s4`, … | IVA pagado por tarifa (acreditable) | Compras → Tarifa … → Impuesto (si el portal lo pide) |
| `cexo` | Compras autorizadas sin impuesto: la compañía compró con su propia exoneración | Compras → Autorizadas sin impuesto (confirmar) |
| `sna` | IVA no acreditable | Crédito fiscal → IVA no acreditable (si existe el campo) |
| `prop` | Proporción de crédito aplicable (%) | Crédito fiscal → Proporcionalidad |
| `cf` | Crédito fiscal del periodo | (releer) |
| `saf` | Saldo a favor del periodo anterior | Determinación → Saldo a favor anterior |
| `det` | Impuesto determinado | (releer) |
| `pagar` / `favor` | Impuesto a pagar / saldo a favor | (releer; es lo que se compara con la Oficina) |

## Reglas de llenado

- Colones enteros. Sin puntos de miles, sin «₡», sin decimales.
- Un campo que el portal calcula solo no se escribe: se relee y se incluye en `campos`.
- Si el portal pide algo que el paquete no trae (régimen especial, casinos, PYME), no inventar:
  reportar en `notas` y dejar el borrador sin ese dato.
- Si el portal muestra prellenado y es distinto, **no** sobreescribir sin reportarlo: anotar el
  prellenado, escribir el valor del paquete, y dejar que la Oficina muestre la diferencia.
