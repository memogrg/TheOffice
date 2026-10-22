# Guía rápida — Oficina IASIMA

## Los tres botones (doble clic)

| Archivo | Qué hace |
|---|---|
| **Abrir Oficina.command** | Abre la oficina con las cifras de la última corrida |
| **Correr agente.command** | El agente lee Odoo y luego abre la oficina actualizada |
| **Configurar correo.command** | Conecta el correo desde el que salen los reportes |

`Oficina IASIMA.html` también se abre solo, con doble clic. No necesita nada instalado.

**La primera vez** que abra un `.command`, macOS puede bloquearlo:
clic derecho → **Abrir** → en el aviso, **Abrir**. Solo pasa una vez.

**Si dice que falta Node.js**: instálelo desde nodejs.org (versión LTS) y repita.
Abrir la oficina NO lo necesita; solo correr el agente.

## Conectar el correo

Necesita una **contraseña de aplicación**, no la del correo.

1. `myaccount.google.com` → Seguridad → activar **Verificación en 2 pasos**.
2. `myaccount.google.com/apppasswords` → nombre `Oficina IASIMA` → **Crear**.
3. Copie las 16 letras.
4. Doble clic en **Configurar correo.command** y péguelas cuando las pida.

Al final debe decir `Correo enviado a ...`.

## Cómo la pantalla muestra lo real

```
Correr agente.command
  ├─ lee el buzón de todas las compañías en Odoo
  ├─ reportes/recepcion-<fecha>.html   ← el correo
  ├─ data/estado.json                  ← las cifras
  └─ Oficina IASIMA.html               ← lo que usted abre
```

El agente le incrusta las cifras al archivo. Por eso abre sin servidor y sin internet.

Arriba a la derecha:
- **verde «corrida real · fecha»** → cifras leídas ese día.
- **gris «sin corrida»** → nadie ha corrido el agente.

El distintivo **REAL** marca a los agentes que ya corren contra Odoo. Hoy solo RECEPCIÓN.

El movimiento de los agentes —café, baño, conversar— es ambientación.
El botón *Pausar movimiento* lo detiene. Las cifras y alertas del panel sí son reales.

---

## Marta y Victor

**Marta** (recepción) lee el buzón y consolida. **Victor** (comunicación) escribe los correos.
Marta nunca manda nada; Victor nunca entra a Odoo.

```
node src/run.js recepcion       # Marta lee y deja la bandeja para Victor
node src/run.js comunicacion    # Victor redacta los correos (NO los manda)
```

Los borradores quedan en `reportes/borradores-victor-<fecha>/`. Ábralos con doble clic
y léalos antes de autorizar nada.

Cuando ya esté conforme y el correo esté configurado:

```
node src/run.js comunicacion --enviar                     # todo a su propio correo, de prueba
node src/run.js comunicacion --enviar --a-los-receptores  # de verdad, a cada receptor
```

Sin `--enviar` no sale ni un correo. Es a propósito.
