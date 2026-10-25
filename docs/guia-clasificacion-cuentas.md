# Guía de clasificación de cuentas de gasto

**Proyecto:** IASIMA ODOO · Oficina de agentes · agente **Cuentas** y **Director**
**Versión:** 1.0 · 25 de octubre de 2026
**Criterio definido por:** Victor (contador)
**Alcance:** líneas de facturas de proveedor (`in_invoice`) y notas de crédito de proveedor (`in_refund`) que van a cuentas de **gasto** o **costo directo**.

> Versión del repositorio: sin nombres de clientes, proveedores ni montos. La versión completa, con ejemplos reales, está en la carpeta de contexto del proyecto (Dropbox de Victor).

---

## 1. Principios

1. **La decisión humana gana siempre.** Una regla confirmada por el contador manda sobre cualquier estadística.
2. **El Excel histórico es referencia, no regla.** Registra lo que se hizo, no lo que es correcto: puede repetir malas costumbres.
3. **Primero entender qué se compró, después ver qué se hizo antes.**
4. **Sin comodines.** `7.01.01` Gastos no justificados y `5.04.99` / `5.04.999` Gastos generales **nunca** se usan para «salir del paso». Lo que no se identifica se reporta.
5. **Lo dudoso se consulta**, no se adivina.
6. **Todo cambio pasa por aprobación humana** y deja rastro: quién decidió, cuándo y por qué.
7. **Cada criterio confirmado se guarda como regla propia del cliente**, para que con el tiempo el agente dependa cada vez menos del Excel.

---

## 2. Orden de decisión

Para cada línea de factura, en este orden. El primer paso que da una respuesta segura gana.

### Paso 0 — ¿Hay una regla propia de ese cliente?

Si existe una regla confirmada para esa compañía (por artículo o por proveedor), se aplica. Es la capa de mayor prioridad.

### Paso 1 — Naturaleza del gasto

Se determina **qué se compró y para qué**, con dos fuentes:

| Fuente | Qué aporta | Disponibilidad hoy en el sandbox |
|---|---|---|
| **Descripción de la línea en el XML** | Qué es el artículo («Medio Pollo+2 acomp», «ENERGIA», «CABLE HDMI») | Siempre (campo `name` de la línea) |
| **Tipo de proveedor** (actividad económica del emisor) | Restaurante, ferretería, farmacia, servicios públicos, transporte… | 98,8 % de las líneas de compra |
| **Código CABYS de la línea** (complementario) | Clasificación oficial de Hacienda del bien o servicio | Viene en el XML, pero el módulo casi no lo guarda (36 de 42.242 líneas) |

Ejemplos: comida servida en restaurante → Relaciones públicas; energía, alumbrado público y tributo de bomberos → Electricidad; combustible → Combustible; flete o encomienda → Encomiendas.

### Paso 2 — Historial del Excel

Si la naturaleza no basta para decidir, se consulta el histórico:

- **Si varios clientes usan una misma cuenta lógica** para ese artículo, se aplica esa cuenta.
- **Cuenta lógica** quiere decir la misma cuenta por significado, aunque el código cambie entre compañías. Ejemplo: `5.04.17.01` y `5.04.017.001` son la misma «Relaciones públicas».
- El historial **del propio cliente** pesa, pero no basta si contradice la naturaleza del gasto o lo que hacen los demás clientes.

### Paso 3 — Consulta al contador

La línea **no se clasifica sola** y va a consulta cuando:

| Caso | Ejemplo |
|---|---|
| **El historial está dividido** | Los mismos alimentos aparecen a la vez en Relaciones públicas, Gastos no justificados y Útiles para oficina |
| **El historial choca con la naturaleza del gasto** | Comida cargada históricamente a «Útiles para oficina» |
| **El gasto parece personal** | Corte de cabello, champú, medicamentos, lentes, comida de supermercado para la casa |

En la consulta se presenta: la línea, el proveedor, la cuenta actual, la cuenta sugerida y por qué se duda.

### Paso 4 — Lo no identificado se reporta

Si ni la naturaleza, ni el historial, ni una regla dan una respuesta, la línea **se reporta** como no identificada. **No se manda a 7.01.01 ni a 5.04.99.**

---

## 3. Reglas propias de cada cliente

Cada criterio que el contador confirma se registra como regla de esa compañía.

**Cómo se crea hoy** (en `main` desde el 25/10/2026):
1. En el chat del Director se dicta la decisión: «todo lo de este proveedor va a 5.04.17.01» o «este artículo siempre va a tal cuenta».
2. El Director la deja **propuesta** en **Aprobaciones → Reglas**, sin escribir en Odoo.
3. El contador la **aprueba** o la **rechaza**.
4. Al aprobarla, queda como regla humana y el agente Cuentas vuelve a revisar esa compañía. Cada línea afectada aparece como propuesta en Aprobaciones.

**Qué debe tener cada regla:**

| Campo | Ejemplo |
|---|---|
| Compañía (alcance) | La compañía cliente (o «todas») |
| Qué cubre | Un artículo, o **todo lo de un proveedor** |
| Cuenta destino | `5.04.17.01` Relaciones públicas |
| Quién decidió | Victor |
| Cuándo | 2026-10-25 |
| Por qué | «Comida de restaurante: gasto de representación» |

**Hoy no se puede** expresar una regla por **tipo de gasto** («toda comida de restaurante, de cualquier proveedor»). Mientras no exista, se usan reglas **por proveedor**.

---

## 4. Flujo de trabajo y candados

```
Director o tablero → Cuentas revisa la compañía (solo propone)
                   → Aprobaciones: el contador aprueba o rechaza línea por línea
                   → «Aplicar en Odoo»: solo lo aprobado, solo si la escritura está habilitada
                   → el agente relee y verifica que la cuenta quedó donde debía
```

Salvaguardas que el agente ya respeta:
- Nunca toca una factura **pagada** o con pago parcial.
- Una factura **publicada** solo se reabre si la cuenta actual es un comodín (Gastos generales, Gastos no justificados) o si hay una regla humana. Cambiar una cuenta específica por otra en un asiento confirmado es criterio contable, no corrección mecánica: va a consulta.
- Revisa **una compañía a la vez**.
- **Verifica después de escribir**: lo que Odoo revierte se reporta como fallo, no como éxito.
- La escritura en Odoo está apagada (`PERMITIR_ESCRITURA`) hasta que TecnoDEM confirme el efecto ante Hacienda de reabrir facturas electrónicas.

---

## 5. Consideraciones fiscales

- **Relaciones públicas frente a Gastos no justificados** tiene efecto en la deducibilidad. La clasificación de comida y atenciones debe confirmarla el contador de cada compañía.
- **Gasto personal:** no se reclasifica a una cuenta deducible. Se consulta (paso 3).
- **Tiquete electrónico (tipo 04):** no da derecho a crédito fiscal ni es deducible como factura. Lo atiende Recepción, no Cuentas.

---

## 6. Ejemplo resuelto

**Factura de un restaurante · en borrador, sin pagar**

| Línea | Cuenta actual | Paso que decide | Cuenta correcta |
|---|---|---|---|
| Plato de comida | 5.04.99 Gastos generales (comodín) | 1: comida de restaurante · 2: el histórico de la compañía ya la tiene en Relaciones públicas | 5.04.17.01 Relaciones públicas |
| Bebida | 5.04.99 Gastos generales | ídem | 5.04.17.01 |

Siguiente paso recomendado: regla **por proveedor** (ese restaurante → 5.04.17.01 en esa compañía), confirmada por el contador.

---

## 7. Decisiones abiertas

| # | Tema | Quién decide |
|---|---|---|
| 1 | **Umbral de consulta:** cuántas líneas o qué monto mínimo van a consulta, para que no se vuelva una revisión manual línea por línea | Victor |
| 2 | **Reglas por tipo de gasto** (no solo por artículo o proveedor) | Memo / David, con Victor |
| 3 | **Guardar el CABYS** de cada línea al importar el XML | TecnoDEM / Memo |
| 4 | **Cómo se lee la naturaleza del gasto:** con CABYS y actividad del proveedor (determinista) o con un modelo de lenguaje solo para los casos dudosos. Ver el principio 7 de la Biblia | Memo, con Victor |
| 5 | **Criterio para alimentación** en compañías con historial dividido (Relaciones públicas, Gastos no justificados o Útiles para oficina) | Victor (contador) |

---

## 8. Fuentes

| Archivo | Ubicación |
|---|---|
| Histórico «Artículos por cuenta de gasto» (09/09/2026) | Carpeta de contexto del proyecto, fuera del repositorio (tiene datos de clientes). Equivalente regenerable con `scripts/construir-catalogo.js` |
| Biblia del proyecto v1.0 | Carpeta de contexto del proyecto |
| Log del proyecto | `logs/` |
| Código del agente | `src/agents/cuentas.js`, `src/catalogo.js`, `data/reglas.json` |
