-- bulk-data-reviewed: a short enum value per host
ALTER TABLE hosts ADD COLUMN health TEXT NOT NULL DEFAULT 'Healthy' CHECK (health IN ('Healthy', 'RateLimited', 'Unhealthy'));
ALTER TABLE hosts ADD COLUMN reported_health TEXT NOT NULL DEFAULT 'Healthy' CHECK (reported_health IN ('Healthy', 'RateLimited'));
