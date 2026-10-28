---
name: declarar-iva
description: >
  This skill should be used when the user asks to "llevar las declaraciones de IVA al portal",
  "cargar el formulario 150 en TRIBU-CR", "preparar los borradores de IVA en Hacienda",
  "declarar el IVA de las compañías" or "registrar el número de la declaración". It takes the
  declarations the Oficina already prepared, fills them as DRAFTS in the TRIBU-CR portal inside
  the user's own browser session, reads every field back, and reports to the Oficina. It never
  clicks Presentar or Pagar.
metadata:
  version: "0.1.0"
---

# Declarar IVA (formulario 150) en TRIBU-CR

Llevar al portal, como **borrador**, cada declaración que la Oficina preparó. La persona entra al
portal con su propio usuario; el plugin no conoce ni guarda contraseñas. Presentar y pagar son
clics de la persona.

## Reglas que no se rompen

1. **Nunca** tocar «Presentar», «Enviar», «Firmar» ni «Pagar». Si un paso del portal solo ofrece
   presentar (sin guardar borrador), detenerse y avisar.
2. **Nunca** cambiar una cifra del paquete. Lo que no calce se reporta; lo corrige la Oficina.
3. **Nunca** pedir, escribir ni guardar credenciales, códigos de seguridad ni la firma digital. Si
   el portal pide iniciar sesión o un código, pedirle a la persona que lo haga en el navegador y
   esperar.
4. Una compañía a la vez. Si el portal muestra otra compañía (otro nombre o cédula), no llenar nada.
5. Si algo del portal no se entiende (una pantalla distinta, un campo que no existe), detenerse en
   esa compañía, tomar captura, reportar con `registrar_carga` con `borradorGuardado: false` y la
   nota de lo que pasó, y seguir con la siguiente.

## Antes de empezar

1. Llamar `estado_oficina` para comprobar que la Oficina responde y ver el periodo.
2. Llamar `declaraciones_pendientes` (periodo que pida la persona, o el que dé la Oficina). Mostrar
   a la persona la lista: compañía, a pagar o a favor, semáforo. Confirmar con qué compañías seguir.
3. Pedirle a la persona que entre a la Oficina Virtual de TRIBU-CR en Chrome con su usuario (Claude
   in Chrome trabaja en esa sesión). Comprobar con una captura que está dentro y que aparece como
   tercero autorizado.

## Por cada declaración

1. Llamar `declaracion` con el id: ahí están las casillas (id, etiqueta, monto), el juez y los
   ajustes. Leer `references/casillas-150.md` para saber a qué campo del portal va cada casilla.
2. En el portal, ir a Declaraciones → nueva declaración → formulario 150 (IVA) → elegir la
   compañía (por cédula, no por nombre parecido) y el periodo. Si el portal ya trae un borrador o una
   declaración presentada para ese periodo, no crear otra: avisar y reportar.
3. Si el portal muestra valores **prellenados** (los que Hacienda arma desde las facturas
   electrónicas), anotarlos por casilla ANTES de escribir nada: van en `prellenado`.
4. Escribir el monto de cada casilla del paquete en su campo, en colones enteros, sin puntos ni
   símbolos. No escribir en campos que el paquete no trae.
5. Guardar como borrador. Confirmar que el portal lo dice (mensaje o estado «borrador»).
6. Releer cada campo del portal y armar `campos = { casillaId: valorLeído }`. Incluir siempre los
   totales y el impuesto a pagar o a favor que calcula el portal.
7. Tomar una captura de la pantalla completa del borrador (nombre: `150-<compañía>-<periodo>.png`).
8. Llamar `registrar_carga` con id, `campos`, `prellenado` (si hubo), `capturas`,
   `borradorGuardado: true` y, en `notas`, cualquier cosa rara. Leer la respuesta: si vienen
   `diferencias`, decirlas a la persona; la Oficina ya puso la declaración en rojo.

## Después: aprobar y presentar

- La aprobación se hace en la **Oficina → pestaña Hacienda**, con el nombre de la persona. El plugin
  no aprueba.
- Cuando la persona toque **Presentar** en el portal, leer el número de declaración del acuse y
  llamar `registrar_presentacion` con el id y ese número. Si la Oficina responde que no está
  aprobada, no insistir: avisar.

## Al terminar

Resumir en una tabla: compañía, a pagar, estado en la Oficina (cargada / con diferencias / no se
pudo), y lo que necesita a la persona. No pegar cifras de otras compañías en el chat de una.
