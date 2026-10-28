# Plugin «Oficina Hacienda»

Lleva al portal TRIBU-CR las declaraciones de IVA (formulario 150) que la Oficina ya preparó, las
deja como **borrador**, relee cada casilla y lo reporta a la Oficina. Presentar y pagar siguen
siendo clics de una persona, que entra al portal con su propio usuario: el plugin no conoce ni
guarda credenciales.

## Qué trae

| Componente | Qué hace |
| --- | --- |
| Skill `declarar-iva` | El paso a paso en el portal, las reglas (nunca presentar, nunca cambiar cifras) y la tabla casilla → campo del portal |
| Servidor MCP `oficina` | Habla con `/api/hacienda` de la Oficina: declaraciones pendientes, detalle, registrar la carga y el número de presentación |

Necesita **Claude in Chrome** para actuar en el navegador de la persona, con permiso solo para el
sitio de Hacienda.

## Variables

| Variable | Valor |
| --- | --- |
| `OFICINA_URL` | Dirección de la Oficina: `http://127.0.0.1:4180` en la misma PC, o la del túnel (con `/t/<inquilino>` si hay varios) |
| `OFICINA_TOKEN` | El `SERVICIO_TOKEN` de la Oficina (vacío si corre local sin token) |
| `OFICINA_QUIEN` | Nombre que queda en la auditoría, p. ej. `plugin (Victor)` |

## Flujo

1. La Oficina (agente Hacienda) prepara los paquetes y el juez los marca. Pestaña **Hacienda**.
2. El plugin toma las pendientes en verde o amarillo, las carga como borrador y relee.
3. La Oficina compara lo leído con el paquete (y con el prellenado de Hacienda) y baja el semáforo si algo no calza.
4. Una persona aprueba en la Oficina, con su nombre.
5. La persona toca Presentar en el portal; el plugin registra el número.

## Empaquetar

```
cd plugin/oficina-hacienda && zip -r ../oficina-hacienda.plugin . -x "*.DS_Store"
```
