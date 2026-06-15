.PHONY: start restart health

start:
	docker compose up -d

restart:
	docker compose restart

health:
	@echo -n "Caddy:      " && docker exec caddy wget -q --tries=1 --spider http://localhost:2019/config/ 2>&1 && echo "OK" || echo "FAIL"
	@echo -n "PostgreSQL: " && docker exec postgres pg_isready -U postgres > /dev/null && echo "OK" || echo "FAIL"
