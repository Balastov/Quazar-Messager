FROM nginx:1.27-alpine

RUN apk add --no-cache openssl gettext

COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint-quazar.sh
RUN chmod +x /docker-entrypoint-quazar.sh

# Remove default site; entrypoint writes conf.d/default.conf
RUN rm -f /etc/nginx/conf.d/default.conf

ENTRYPOINT ["/docker-entrypoint-quazar.sh"]
