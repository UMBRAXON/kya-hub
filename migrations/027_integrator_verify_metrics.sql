-- Daily aggregates for integrator status/agent reads (ops / honest traction metrics)

BEGIN;

CREATE TABLE IF NOT EXISTS integrator_verify_daily (
    day             DATE NOT NULL DEFAULT (CURRENT_DATE AT TIME ZONE 'UTC'),
    source          VARCHAR(80) NOT NULL,
    calls           BIGINT NOT NULL DEFAULT 0,
    verified_ok     BIGINT NOT NULL DEFAULT 0,
    cert_checks     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source)
);

CREATE INDEX IF NOT EXISTS idx_integrator_verify_daily_day
    ON integrator_verify_daily (day DESC);

GRANT SELECT, INSERT, UPDATE ON integrator_verify_daily TO kyahub_app;

COMMIT;
