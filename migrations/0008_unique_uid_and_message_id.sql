-- One row per uid, and per Message-ID from one sender, in each (tenant,
-- principal, folder) mailbox. The sender is the host-authorized envelope
-- sender, not the From header, so a forged From cannot suppress mail; rows
-- written before it was recorded fall back to their From, or to '' when they
-- have none, so the key is never NULL. Before 0.2.0
-- appends raced on an in-memory counter, so a database may already hold
-- duplicates; they are resolved first, without deleting a row. Duplicate uids
-- keep the oldest row on its uid and move each later one past both uid_next
-- and the mailbox's highest uid, since a racing 0.1.0 writer could leave
-- uid_next behind. A later copy of a Message-ID keeps its row and raw frame,
-- and only its cached "message_id" is cleared.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'sender_address'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail"
      ADD COLUMN "sender_address" text NOT NULL DEFAULT '';
    UPDATE "mailbox"."principal_mail"
      SET "sender_address" = "from_address"
      WHERE "from_address" IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_tenant_id_principal_id_folder_uid_idx"') IS NULL THEN
    WITH dup AS (
      SELECT "id", "tenant_id", "principal_id", "folder",
        row_number() OVER (
          PARTITION BY "tenant_id", "principal_id", "folder", "uid"
          ORDER BY "created_at", "id"
        ) AS "n"
      FROM "mailbox"."principal_mail"
    ), top AS (
      SELECT "tenant_id", "principal_id", "folder", max("uid") AS "uid"
      FROM "mailbox"."principal_mail"
      GROUP BY "tenant_id", "principal_id", "folder"
    ), moved AS (
      SELECT d."id",
        GREATEST(coalesce(s."uid_next", 1) - 1, t."uid") + row_number() OVER (
          PARTITION BY d."tenant_id", d."principal_id", d."folder"
          ORDER BY d."id"
        ) AS "uid"
      FROM dup AS d
      JOIN top AS t
        ON t."tenant_id" = d."tenant_id" AND t."principal_id" = d."principal_id"
          AND t."folder" = d."folder"
      LEFT JOIN "mailbox"."mailbox_state" AS s
        ON s."tenant_id" = d."tenant_id" AND s."principal_id" = d."principal_id"
          AND s."folder" = d."folder"
      WHERE d."n" > 1
    )
    UPDATE "mailbox"."principal_mail" AS pm
      SET "uid" = moved."uid"
      FROM moved
      WHERE pm."id" = moved."id";
    INSERT INTO "mailbox"."mailbox_state"
        ("tenant_id", "principal_id", "folder", "uid_validity", "uid_next", "highest_modseq")
      SELECT "tenant_id", "principal_id", "folder",
             extract(epoch FROM min("created_at"))::bigint,
             max("uid") + 1,
             max("modseq")
      FROM "mailbox"."principal_mail"
      GROUP BY "tenant_id", "principal_id", "folder"
      ON CONFLICT ("tenant_id", "principal_id", "folder") DO UPDATE
        SET "uid_next" = GREATEST("mailbox_state"."uid_next", excluded."uid_next"),
            "highest_modseq" = GREATEST("mailbox_state"."highest_modseq", excluded."highest_modseq");
    CREATE UNIQUE INDEX "principal_mail_tenant_id_principal_id_folder_uid_idx"
      ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "folder", "uid");
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_folder_message_id_sender_address_idx"') IS NULL THEN
    UPDATE "mailbox"."principal_mail" AS pm
      SET "message_id" = NULL
      FROM (
        SELECT "id",
          row_number() OVER (
            PARTITION BY "tenant_id", "principal_id", "folder", "message_id",
              "sender_address"
            ORDER BY "created_at", "id"
          ) AS "n"
        FROM "mailbox"."principal_mail"
        WHERE "message_id" IS NOT NULL
      ) AS dup
      WHERE pm."id" = dup."id" AND dup."n" > 1;
    CREATE UNIQUE INDEX "principal_mail_folder_message_id_sender_address_idx"
      ON "mailbox"."principal_mail"
        ("tenant_id", "principal_id", "folder", "message_id", "sender_address")
      WHERE "message_id" IS NOT NULL;
  END IF;
END $$;
