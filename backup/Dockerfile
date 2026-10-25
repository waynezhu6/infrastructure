# Nightly backups of the shared Postgres (every app's database) and the
# server-only secrets/, kept on the server and copied off it. Same major
# version as the postgres service, so pg_dumpall matches the server.
FROM postgres:16-alpine
RUN apk add --no-cache rclone gnupg
COPY backup.sh restore-test.sh nightly.sh /usr/local/bin/
CMD ["nightly.sh"]
