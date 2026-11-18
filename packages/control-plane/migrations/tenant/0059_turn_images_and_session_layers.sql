CREATE TABLE turn_full_images (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  guest_image_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_layered_images (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  base_image_digest TEXT NOT NULL,
  harness_layer_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_prebuild_layers (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id),
  prebuild_id TEXT NOT NULL REFERENCES prebuild_layers (prebuild_id),
  created_at INTEGER NOT NULL
);

CREATE TABLE session_layer_absences (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id),
  reason TEXT NOT NULL CHECK (reason IN ('BuildsPrebuild', 'HostNotAmd64', 'NoAmd64Image', 'NoPrebuild', 'OtherGuestImage', 'NotRecorded')),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO session_layer_absences (session_id, reason, detail, created_at)
SELECT session_id, 'BuildsPrebuild', 'the session builds a prebuild of ' || repository || ', so its box starts from the guest image alone', created_at
FROM sessions WHERE session_id IN (SELECT session_id FROM prebuild_sessions);

INSERT INTO session_layer_absences (session_id, reason, detail, created_at)
SELECT session_id, 'NotRecorded', 'the session''s first box booted before the control plane recorded which prebuild layer it restored; start a new session of ' || repository || ' to see the layer its box starts from', created_at
FROM sessions WHERE session_id IN (SELECT session_id FROM snapshots) AND session_id NOT IN (SELECT session_id FROM prebuild_sessions);
