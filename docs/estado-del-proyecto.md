# Estado del proyecto — anexo a la Biblia v1.0

La Biblia (v1.0, 25 oct 2026) documenta el estado al **10 de setiembre**. Este anexo resume lo construido después, en la rama `app` (hoy `main`), para que la Biblia se actualice (corrección 3 del log del 25/10). Sin nombres de clientes.

## Lo que cambió respecto de la Biblia

| Tema | Biblia (10 set) | Hoy |
|---|---|---|
| Forma de uso | Agentes por terminal y `.command`; oficina 2D como HTML | **Servicio web** (`npm run servicio`): base SQLite incorporada en Node, calendario de corridas, API y app web. La oficina 2D sigue, servida por la app |
| Aprobaciones | `--aplicar` / `--enviar` por terminal | Cola en la app: propuestas de Cuentas, correos de Victor y **reglas** se aprueban o rechazan con nombre y quedan en Auditoría |
| Director | Léxico, sin LLM (principio 7) | **Modelo de lenguaje** con los agentes como herramientas de solo lectura y propuesta; el léxico queda de respaldo sin clave. Memoria por persona (30 días); la app y la oficina 2D comparten la conversación |
| Clasificación de cuentas | Catálogo histórico (regla → exacto → aproximado) | **Guía de Victor** (`docs/guia-clasificacion-cuentas.md`, `src/clasificador.js`): regla propia → naturaleza del gasto (línea + tipo de proveedor) → historial → consulta; nunca un comodín. Reglas por artículo, proveedor o **tipo de gasto**, dictadas en el chat o desde una consulta, siempre con aprobación |
| Usuarios | Sin usuarios; credencial `admin` | Usuario de servicio en Odoo; en la app, roles **contable** y **receptor** (cada receptor ve solo lo suyo), entrada por enlace de un solo uso o token |
| Varias firmas | Una instancia | **Multitenencia**: un inquilino por firma, con su Odoo, base, reglas, calendario, Director y marca |
| Despliegue | Local en el Mac | Local en la PC + túnel para pruebas; Docker, Fly.io y Render listos; CI en GitHub Actions |
| Agentes | 4 (Recepción, Conciliación, Cuentas, Comunicación) | + **Diagnóstico, Recurrentes, Bancos, Documentos, Cierre y Estados financieros** (fase 3A de la matriz B1/B2, completa, solo lectura), en la pestaña Hallazgos |
| Asientos | — | **Fase 3B**: asientos de diario propuestos (Cierre, diferencial cambiario, diferidos, depreciación o el Director) en Aprobaciones; se crean en Odoo solo aprobados y con `PERMITIR_ESCRITURA_ASIENTOS=si` (por omisión en borrador) |
| Plan de cuentas | Cambios a mano en cada compañía | **Cambios masivos** (objetivo 5): previsualizar en N compañías → aprobar → ejecutar con `PERMITIR_ESCRITURA_CUENTAS=si` → verificar |
| Bancos | Conciliación a mano en el módulo de TecnoDEM; sin extractos en Odoo | **Fase 3C (base)**: extractos de cualquier banco (CSV, TXT, Excel) subidos en la app, emparejados con libros; cargos, intereses y transferencias propias como asientos propuestos; cobros y pagos con la factura que calza; saldo del banco contra libros. Revisión de zips de PDF+XML contra Odoo y el buzón |
| Autonomía | NIVELES → AUTÓNOMO en la matriz, sin medir | **Fase 4**: historial por tipo × compañía desde la cola y la auditoría; candidato tras dos meses seguidos sin correcciones; una persona la otorga; se aprueba solo lo que pasa las validaciones; se revoca sola si falla en Odoo |
| Pruebas | Ninguna automatizada | 109 pruebas (`npm test`) con un Odoo simulado |

## Decisiones que la Biblia todavía no registra (pendientes de Memo)

1. **Local o nube** (error 4 del log): la sección 12 dice «aplicación local»; el código soporta ambas y hoy corre local con túnel. Hace falta fijar la decisión.
2. **Principio 7** («sin LLM en ningún agente»): el Director ya usa un modelo de lenguaje, solo para leer y proponer; la lógica contable sigue determinista. Conviene reescribir el principio en esos términos.
3. **Repositorio público** con datos de prueba en el historial (error 7): se sacó la base de pruebas del árbol, pero sigue en el historial de un commit. Pasar el repositorio a privado (corrección 15) o reescribir el historial.

## Lo que sigue bloqueado

- **Escritura en Odoo**: la copia de pruebas apunta al ambiente de producción de Hacienda; hasta que TecnoDEM lo confirme, Cuentas solo propone.
- **Envío de correo**: sin SMTP configurado, Victor redacta pero no envía.
