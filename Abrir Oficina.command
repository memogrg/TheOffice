#!/bin/bash
# Doble clic para ver la oficina con las cifras de la ultima corrida.
cd "$(dirname "$0")" || exit 1
if [ ! -f "Oficina IASIMA.html" ]; then
  echo "Todavia no existe la oficina. Haga doble clic primero en 'Correr agente.command'."
  read -n 1 -s -r -p "Presione cualquier tecla para cerrar..."
  exit 1
fi
open "Oficina IASIMA.html"
