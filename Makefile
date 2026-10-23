.PHONY: start restart health backup restore-test

start:
	docker compose up -d

restart:
	docker compose restart

health:
	@echo -n "Caddy:      " && docker exec caddy wget -q --tries=1 --spider http://localhost:2019/config/ 2>&1 && echo "OK" || echo "FAIL"
	@echo -n "PostgreSQL: " && docker exec postgres pg_isready -U postgres > /dev/null && echo "OK" || echo "FAIL"

# Back up now, as the nightly run does (README, "Backups").
backup:
	docker exec backup backup.sh

# Load a backup into a throwaway Postgres and count rows; the newest by
# default, or FILE=backup-<stamp>.tar.gpg from ~/infrastructure/backups.
restore-test:
	docker exec backup restore-test.sh $(if $(FILE),/backups/$(notdir $(FILE)))
