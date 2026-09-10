#!/bin/bash
# Doble clic para que el agente de Recepcion lea Odoo y actualice la oficina.
cd "$(dirname "$0")" || exit 1
clear
echo "==============================================="
echo "   OFICINA IASIMA  ·  agente de Recepcion"
echo "==============================================="
echo ""

NODE=""
for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  if [ -x "$p" ]; then NODE="$p"; break; fi
done

if [ -z "$NODE" ]; then
  echo "  No encontre Node.js en esta Mac."
  echo ""
  echo "  Que hacer:"
  echo "   1. Abra https://nodejs.org"
  echo "   2. Descargue la version LTS y instalela (siguiente, siguiente, listo)"
  echo "   3. Vuelva a hacer doble clic en este archivo"
  echo ""
  read -n 1 -s -r -p "  Presione cualquier tecla para cerrar..."
  exit 1
fi

echo "  Node encontrado: $($NODE -v)"
echo ""
"$NODE" src/run.js recepcion
RES=$?
echo ""
if [ $RES -eq 0 ]; then
  echo "  Abriendo la oficina..."
  open "Oficina IASIMA.html" 2>/dev/null
else
  echo "  El agente fallo. Revise el mensaje de arriba."
fi
echo ""
read -n 1 -s -r -p "  Presione cualquier tecla para cerrar..."
