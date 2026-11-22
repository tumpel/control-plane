DROP TABLE namespace_connections;

ALTER TABLE prebuilds DROP COLUMN provider;

DROP TRIGGER turns_delete_owned_rows;

CREATE TRIGGER turns_delete_owned_rows BEFORE DELETE ON turns
BEGIN
  DELETE FROM turn_failures WHERE turn_id = OLD.turn_id;
  DELETE FROM credential_handovers WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_full_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_layered_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_goals WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_warnings WHERE turn_id = OLD.turn_id;
END;

DROP TABLE turn_refusals;
