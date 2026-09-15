-- Runs once, only on first init of an empty postgres_data volume (official postgres image
-- behaviour for anything mounted at /docker-entrypoint-initdb.d/). POSTGRES_DB only creates one
-- database (clinic_os_dev); this creates the second one integration tests run against, per the
-- decision recorded in the chat record following SCHEMA-DECISIONS.md D13: a dedicated test
-- database, not truncate-between-tests against the dev database, so a failed run can't leave
-- state that makes the next run pass, and a developer poking at the dev DB can't break CI.
CREATE DATABASE clinic_os_test;
