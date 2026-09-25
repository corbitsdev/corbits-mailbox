-- IMAP-shaped columns on the mail plane, numbered per (tenant, principal,
-- folder) in arrival order, in the replay that adds them. Every 0.1.0
-- database already has them. A pre-0.1.0 database takes folder and \Seen
-- from its "mailbox"."mailbox" row (Trash wins over Archive) before 0005
-- drops that table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'uid'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail"
      ADD COLUMN "folder" text NOT NULL DEFAULT 'INBOX',
      ADD COLUMN "uid" bigint,
      ADD COLUMN "modseq" bigint,
      ADD COLUMN "flags" text[] NOT NULL DEFAULT '{}';
    IF to_regclass('"mailbox"."mailbox"') IS NOT NULL THEN
      UPDATE "mailbox"."principal_mail" AS pm
        SET "folder" = CASE
              WHEN mb."trashed_at" IS NOT NULL THEN 'Trash'
              WHEN mb."archived_at" IS NOT NULL THEN 'Archive'
              ELSE 'INBOX'
            END,
            "flags" = CASE
              WHEN mb."read_at" IS NOT NULL THEN ARRAY['\Seen']
              ELSE '{}'
            END
        FROM "mailbox"."mailbox" AS mb
        WHERE mb."id" = pm."id";
    END IF;
    UPDATE "mailbox"."principal_mail" AS pm
      SET "uid" = seq."rn", "modseq" = seq."rn"
      FROM (
        SELECT "id",
          row_number() OVER (
            PARTITION BY "tenant_id", "principal_id", "folder"
            ORDER BY "created_at", "id"
          ) AS "rn"
        FROM "mailbox"."principal_mail"
      ) AS seq
      WHERE pm."id" = seq."id";
  END IF;
END $$;

-- Per-(tenant, principal, folder) IMAP counters, seeded from the mail plane
-- only in the replay that creates the table. uid_validity is the group's
-- earliest created_at in epoch seconds.
DO $$
BEGIN
  IF to_regclass('"mailbox"."mailbox_state"') IS NULL THEN
    CREATE TABLE "mailbox"."mailbox_state" (
      "tenant_id" text NOT NULL,
      "principal_id" text NOT NULL,
      "folder" text NOT NULL,
      "uid_validity" bigint NOT NULL,
      "uid_next" bigint NOT NULL,
      "highest_modseq" bigint NOT NULL,
      PRIMARY KEY ("tenant_id", "principal_id", "folder"),
      CONSTRAINT "mailbox_state_tenant_id_tenant_id_fk"
        FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant" ("id") ON DELETE CASCADE,
      CONSTRAINT "mailbox_state_principal_id_principal_id_fk"
        FOREIGN KEY ("principal_id") REFERENCES "public"."principal" ("id") ON DELETE CASCADE
    );
    INSERT INTO "mailbox"."mailbox_state"
        ("tenant_id", "principal_id", "folder", "uid_validity", "uid_next", "highest_modseq")
      SELECT "tenant_id", "principal_id", "folder",
             extract(epoch FROM min("created_at"))::bigint,
             max("uid") + 1,
             max("modseq")
      FROM "mailbox"."principal_mail"
      GROUP BY "tenant_id", "principal_id", "folder";
  END IF;
END $$;
