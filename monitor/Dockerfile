# Health checks for every app, reported to healthchecks.io, plus request
# counts from Caddy's access logs (README, "Monitoring").
FROM alpine:3.20
RUN apk add --no-cache bash jq
COPY monitor.sh traffic.sh /usr/local/bin/
CMD ["monitor.sh"]
