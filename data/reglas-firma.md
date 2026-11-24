# Reglas de la firma (criterio contable fijo del Director)

Este archivo lo lee el Director en cada conversación. Son las reglas duras de registro y de cierre de la
firma, dichas por el contador; no son sugerencias. Sin nombres de clientes ni montos. Se edita a mano
(el contador o quien administra la Oficina) y entra en el siguiente mensaje al Director.

## Clasificación de gastos
- Primero la regla propia del cliente, luego la naturaleza del gasto (qué se compró y a quién), luego el historial de esa compañía; lo que no cierra va a **consulta al contador**. Nunca 7.01.01, 5.04.99 ni 5.04.999 como destino: no son comodines.
- **Internet** (ICE, Kölbi, Tigo, Cabletica, Liberty u otro proveedor) va a **5.04.02.04**. En **5.04.02.01 Teléfono** se queda solo la voz básica y el alquiler de módem. Que una factura esté en Teléfono no la hace «aceptable».
- **Comida servida en restaurante** va a **5.04.17.01 Relaciones públicas**. Si el historial de la compañía está dividido entre dos cuentas, se levanta consulta; no se escoge una «por parecer razonable».
- **No se crean cuentas** si no hacen falta. Cada cuenta nueva con saldo obliga a tocar la plantilla Excel del cliente: antes de proponer una cuenta nueva, buscar la cuenta lógica equivalente que ya exista.
- Las reglas de clasificación que la app guarda son **por proveedor o por artículo** (y, cuando se construya, por naturaleza). No prometer una «regla por naturaleza» que todavía no existe: proponer la regla por proveedor y decir que es por proveedor.
- Relaciones públicas frente a Gastos no justificados afecta la deducibilidad: lo confirma el contador.

## Meses ya entregados al cliente
- Un mes **entregado** (estados financieros enviados al cliente) **no se toca**. Lo que llega tarde con fecha de ese mes **se reporta y se escala** al contador; no se registra por cuenta propia ni se recomienda «ajustarlo en el mes corriente» como si fuera lo normal.
- Un asiento con fecha de un mes ya reportado obliga a rehacer los estados de ese mes y de todos los siguientes. Por eso los asientos que propone la Oficina (cierre, diferidos, depreciación, extractos, cambiario) no deben llevar fecha de un mes bloqueado o entregado.
- El retrabajo número uno de la firma es el **arrastre retroactivo**: asientos creados o modificados después de entregar un mes, con fecha contable de ese mes.

## Controles que la firma aplica en cada cierre (B3)
Cuando pregunten por los controles de cierre, esta es la lista de la firma. Decí cuáles están ya en la Oficina (Cierre de mes y Hallazgos) y cuáles todavía no; no los inventés como hechos.
1. Variación de ±15 % por cuenta de resultados contra el promedio móvil de 18 meses (sin diciembre ni el asiento de cierre).
2. Salarios por pagar en ₡0 al cierre de cada mes.
3. Saldos contra natura (salvo depreciación acumulada): proveedores con saldo deudor, clientes con saldo acreedor, cobros sin contacto, contactos duplicados del mismo tercero.
4. Cuadre del balance: activo = pasivo + patrimonio.
5. Contravalidación contra el balance y el estado de resultados nativos de Odoo (umbral ₡1 por total y subtotal).
6. Arrastre retroactivo (asientos de meses entregados, por fecha de creación o modificación).
7. Candados del periodo: fechas de bloqueo puestas al entregar; ningún asiento propuesto con fecha de un mes bloqueado.
8. Servicios públicos registrados dos veces (con el pago y con la factura del mismo periodo).
9. Ventas sin costo de ventas en compañías con inventario.
10. Criterio de capitalización: umbral de monto definido por el contador; lo que queda cerca del umbral se consulta.

## Activos fijos
- Vidas útiles estándar de la firma: muebles 10 años, equipo de cómputo 5, vehículos 10, inmuebles 50, equipo de estación de servicio 10. Las revaluaciones toman la vida del activo asociado.

## Plan de cuentas
- El código lleva dos dígitos por segmento y la cuenta padre tiene que ser la correcta. Un cambio masivo al plan se valida contra eso antes de proponerlo.

## Cómo hablar del estado de la Oficina
- Si la herramienta «estado» dice que Odoo rechaza la conexión (salud `sin-acceso`), eso se dice primero y tal cual: «Odoo rechaza la conexión desde … por …; hay que avisar a quien administra la Oficina». Nunca decir que «no hay corridas» o que «la instancia está en estado inicial» cuando lo que hay son corridas fallidas.
