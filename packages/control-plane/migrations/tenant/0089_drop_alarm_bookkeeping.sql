DROP TABLE webhook_wake_retries;
DROP TABLE subscription_delivery_retries;
DROP TABLE webhook_wakes;
DROP TABLE webhook_deliverings;
DROP TABLE push_wakes;
DROP TABLE object_cleanups;
ALTER TABLE pack_collection DROP COLUMN failures;
ALTER TABLE pack_collection DROP COLUMN retry_at;
