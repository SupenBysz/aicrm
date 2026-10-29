#!/usr/bin/env python3
"""Run contributed database tests in a disposable, locally owned PostgreSQL cluster.

Never reads a business DSN. Requires initdb/pg_ctl/createdb/psql in PATH.
Each fixture owns a separate database; all files and processes are cleaned on exit.
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(argv, **kwargs):
    subprocess.run(argv, check=True, cwd=ROOT, **kwargs)


def main():
    for binary in ("initdb", "pg_ctl", "createdb", "psql", "go"):
        if not shutil.which(binary):
            raise SystemExit(f"Required executable missing: {binary}")
    with tempfile.TemporaryDirectory(prefix="kycrm-contribution-db-") as tmp:
        folder = Path(tmp)
        data = folder / "data"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        run(["initdb", "-D", str(data), "-A", "trust", "-U", "kycrm_test_runner"], stdout=subprocess.DEVNULL)
        started = False
        try:
            run(["pg_ctl", "-D", str(data), "-l", str(folder / "postgres.log"), "-o",
                 f"-h 127.0.0.1 -p {port} -k {folder}", "-w", "start"])
            started = True
            base = f"postgresql://kycrm_test_runner@127.0.0.1:{port}/"

            def database(name):
                run(["createdb", "--maintenance-db=" + base + "postgres", name])
                return base + name + "?sslmode=disable"

            cases = [
                ("profile", "KYCRM_PROFILE_TEST_DATABASE_URL", "services/ky-org-service/internal/store", "TestProfileConditionalDatabase"),
                ("brand", "KYCRM_BRAND_TEST_DATABASE_URL", "services/ky-org-service/internal/store", "TestBrandDatabase"),
                ("auth_stats", "KYCRM_STATS_TEST_DATABASE_URL", "services/ky-auth-service/internal/store", "TestStatisticsDatabase"),
                ("membership_stats", "KYCRM_STATS_TEST_DATABASE_URL", "services/ky-membership-service/internal/store", "TestStatisticsDatabase"),
                ("domain_org", "DOMAIN_TEST_DATABASE_URL", "services/ky-org-service/internal/domains", "TestDomainDatabase"),
                ("domain_auth", "DOMAIN_AUTH_TEST_DATABASE_URL", "services/ky-auth-service/internal/server", "TestDomainSessionDatabase"),
            ]
            for name, variable, package, test in cases:
                prefix = "domain_test_" if name.startswith("domain_") else "kycrm_test_"
                dsn = database(prefix + name)
                run(["go", "test", "./" + package, "-run", "^" + test + "$", "-count=1", "-v"],
                    env={**os.environ, variable: dsn})
            # Validate both a new database and an upgrade from the actual <=99 baseline.
            for mode in ("fresh", "upgrade"):
                dsn = database("kycrm_test_migrations_" + mode)
                env = {**os.environ, "KY_TENANT_DATABASE_URL": dsn, "KY_EXECUTE_DATABASE_DEPLOY": "1"}
                if mode == "upgrade":
                    baseline = folder / "baseline"
                    (baseline / "scripts").mkdir(parents=True)
                    (baseline / "ops/db").mkdir(parents=True)
                    shutil.copy(ROOT / "scripts/deploy_database.sh", baseline / "scripts")
                    for sql in (ROOT / "ops/db").glob("[0-9][0-9][0-9]_*.sql"):
                        if int(sql.name[:3]) <= 99:
                            shutil.copy(sql, baseline / "ops/db")
                    run(["bash", str(baseline / "scripts/deploy_database.sh")], env=env, stdout=subprocess.DEVNULL)
                for _ in range(2):
                    run(["bash", "scripts/deploy_database.sh"], env=env, stdout=subprocess.DEVNULL)
                expected = len(list((ROOT / "ops/db").glob("[0-9][0-9][0-9]_*.sql")))
                actual = subprocess.check_output(["psql", dsn, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM ky_schema_migration"], text=True).strip()
                if int(actual) != expected:
                    raise RuntimeError(f"migration ledger incomplete: {actual}, expected {expected}")
                sql = "SELECT version,filename FROM ky_schema_migration WHERE version>=100 ORDER BY version"
                run(["psql", dsn, "-X", "-v", "ON_ERROR_STOP=1", "-c", sql])
                print(f"PASS migration {mode} and idempotent rerun", flush=True)
        finally:
            if started:
                run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
