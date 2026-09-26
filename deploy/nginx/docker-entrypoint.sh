#!/bin/sh
set -e

DOMAIN="${DOMAIN:-quazar-msg.ru}"
LE_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
LE_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
TMP_DIR="/etc/nginx/selfsigned"
TMP_CERT="${TMP_DIR}/fullchain.pem"
TMP_KEY="${TMP_DIR}/privkey.pem"

if [ -f "$LE_CERT" ] && [ -f "$LE_KEY" ]; then
  export SSL_CERT="$LE_CERT"
  export SSL_KEY="$LE_KEY"
  echo "Using Let's Encrypt certificate for ${DOMAIN}"
else
  mkdir -p "$TMP_DIR"
  if [ ! -f "$TMP_CERT" ]; then
    echo "No Let's Encrypt cert yet; creating temporary self-signed cert for ${DOMAIN}"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3 \
      -keyout "$TMP_KEY" \
      -out "$TMP_CERT" \
      -subj "/CN=${DOMAIN}"
  fi
  export SSL_CERT="$TMP_CERT"
  export SSL_KEY="$TMP_KEY"
fi

envsubst '${DOMAIN} ${SSL_CERT} ${SSL_KEY}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
