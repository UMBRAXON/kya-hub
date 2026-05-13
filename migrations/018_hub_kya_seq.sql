-- Monotonic public agent IDs: kya_id = UMBRA- + 6-digit zero-padded decimal
-- from hub_kya_seq (aligned with max(agents.id) at migration time).
-- Gaps are possible (failed txn after nextval, collision skip with legacy random IDs).
--
-- Apply once per environment. Re-running the setval block can move the counter
-- backward and duplicate kya_id if higher values were already consumed.

CREATE SEQUENCE IF NOT EXISTS hub_kya_seq;

SELECT setval(
    'hub_kya_seq',
    (SELECT COALESCE(MAX(id), 0)::bigint FROM agents),
    true
);

COMMENT ON SEQUENCE hub_kya_seq IS 'Source for sequential agents.kya_id (UMBRA-000001 style); see registerAgent in server.js';

GRANT USAGE, SELECT ON SEQUENCE hub_kya_seq TO kyahub_app;
