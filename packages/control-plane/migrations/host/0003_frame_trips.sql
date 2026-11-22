-- bulk-data-reviewed: trips holds at most three epoch timestamps from the last hour
CREATE TABLE frame_trips (
  frame_trips_id INTEGER PRIMARY KEY CHECK (frame_trips_id = 1),
  trips TEXT NOT NULL
);
