#!/bin/bash
# Doble clic para conectar el correo desde el que salen los reportes.
cd "$(dirname "$0")" || exit 1
clear
echo "==============================================="
echo "   CONECTAR EL CORREO DE LA OFICINA"
echo "==============================================="
echo ""
echo "  Necesita una CONTRASENA DE APLICACION, no la"
echo "  contrasena normal del correo."
echo ""
echo "  Si usa Gmail o Google Workspace:"
echo "   1. Entre a  myaccount.google.com/apppasswords"
echo "   2. Escriba el nombre: Oficina IASIMA"
echo "   3. Copie el codigo de 16 letras que le da"
echo ""
read -p "  Correo desde el que se envia: " CORREO
[ -z "$CORREO" ] && echo "  Sin correo, no hago nada." && read -n 1 -s -r && exit 1
read -s -p "  Contrasena de aplicacion (no se vera al escribir): " CLAVE
echo ""
read -p "  Correo que RECIBE el reporte [$CORREO]: " PARA
[ -z "$PARA" ] && PARA="$CORREO"
CLAVE=$(echo "$CLAVE" | tr -d ' ')

case "$CORREO" in
  *@gmail.com|*@googlemail.com) HOST="smtp.gmail.com" ;;
  *@outlook.com|*@hotmail.com|*@live.com) HOST="smtp-mail.outlook.com" ;;
  *) HOST="smtp.gmail.com" ;;
esac
echo ""
read -p "  Servidor SMTP [$HOST]: " H2
[ -n "$H2" ] && HOST="$H2"
PUERTO=465
[ "$HOST" = "smtp-mail.outlook.com" ] && PUERTO=587

python3 - "$CORREO" "$CLAVE" "$PARA" "$HOST" "$PUERTO" <<'PY'
import sys, io, re
correo, clave, para, host, puerto = sys.argv[1:6]
s = io.open(".env", encoding="utf-8").read()
def set_(k, v):
    global s
    if re.search(r"(?m)^%s=" % re.escape(k), s):
        s = re.sub(r"(?m)^%s=.*$" % re.escape(k), "%s=%s" % (k, v), s)
    else:
        s = s.rstrip("\n") + "\n%s=%s\n" % (k, v)
set_("SMTP_HOST", host); set_("SMTP_PORT", puerto)
set_("SMTP_USER", correo); set_("SMTP_PASS", clave)
set_("REPORTE_PARA", para); set_("REPORTE_DE", "Oficina IASIMA <%s>" % correo)
io.open(".env", "w", encoding="utf-8").write(s)
print("  Guardado.")
PY

echo ""
echo "  Probando el envio..."
NODE=""
for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  if [ -x "$p" ]; then NODE="$p"; break; fi
done
if [ -z "$NODE" ]; then
  echo "  Falta Node.js. Instalelo desde nodejs.org y corra 'Correr agente.command'."
else
  if [ ! -d node_modules ]; then echo "  Instalando el envio de correo (una sola vez)..."; "$NODE" -e "0" ; npm install --silent 2>/dev/null || echo "  (si fallo, corra: npm install)"; fi
  "$NODE" src/run.js recepcion
fi
echo ""
read -n 1 -s -r -p "  Presione cualquier tecla para cerrar..."
