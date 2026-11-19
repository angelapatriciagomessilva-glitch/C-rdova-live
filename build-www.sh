#!/bin/sh
# Copia o app (pasta app/) para www/ e injeta o cordova.js. Uso: sh build-www.sh [pasta-do-app]   (padrão: app)
SRC="${1:-app}"
[ -f "$SRC/index.html" ] || { echo "App não encontrado em $SRC"; exit 1; }
rm -rf www && mkdir www && cp -r "$SRC"/. www/
sed -i 's#<script type="module" src="js/live.js"></script>#<script src="cordova.js"></script>\n<script type="module" src="js/live.js"></script>#' www/index.html
grep -q 'cordova.js' www/index.html && echo "www/ pronto." || { echo "Falha ao injetar cordova.js"; exit 1; }
