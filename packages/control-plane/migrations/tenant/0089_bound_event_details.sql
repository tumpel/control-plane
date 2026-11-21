UPDATE events SET payload = json_set(payload, '$.detail', substr(json_extract(payload, '$.detail'), 1, 8192))
WHERE length(CAST(json_extract(payload, '$.detail') AS BLOB)) > 16384;

UPDATE events SET payload = json_set(payload, '$.refusal.detail', substr(json_extract(payload, '$.refusal.detail'), 1, 8192))
WHERE length(CAST(json_extract(payload, '$.refusal.detail') AS BLOB)) > 16384;

UPDATE turn_failures SET detail = substr(detail, 1, 8192) WHERE length(CAST(detail AS BLOB)) > 16384;
