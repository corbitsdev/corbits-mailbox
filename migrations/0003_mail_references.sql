-- The References chain, backfilled only in the replay that adds the column.
-- Same header slicing as 0002, plus unfolding: References is the header that
-- wraps across continuation lines.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'references'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail" ADD COLUMN "references" jsonb;
    UPDATE "mailbox"."principal_mail" AS pm
      SET "references" = h."references"
      FROM (
        SELECT "id",
          (
            SELECT jsonb_agg(m[1] ORDER BY ord)
              FROM regexp_matches(
                     COALESCE(substring(head from '(?ni)^References:[ \t]*(.*)$'), ''),
                     '<[^<>]+>', 'g'
                   ) WITH ORDINALITY AS matched(m, ord)
          ) AS "references"
        FROM (
          SELECT "id",
            regexp_replace(
              replace(
                convert_from(clean_bytes, 'LATIN1'),
                chr(13) || chr(10), chr(10)
              ),
              chr(10) || '[ \t]+', ' ', 'g'
            ) AS head
          FROM (
            SELECT sliced."id",
              COALESCE(
                (SELECT string_agg(set_byte(decode('00', 'hex'), 0, b), ''::bytea ORDER BY i)
                   FROM generate_series(0, octet_length(sliced.head_bytes) - 1) AS i,
                        LATERAL (SELECT get_byte(sliced.head_bytes, i) AS b) AS byte
                  WHERE b <> 0),
                ''::bytea
              ) AS clean_bytes
            FROM (
              SELECT "id",
                CASE
                  WHEN position(decode('0d0a0d0a', 'hex') IN "raw") > 0
                    THEN substring("raw" FOR position(decode('0d0a0d0a', 'hex') IN "raw") - 1)
                  WHEN position(decode('0a0a', 'hex') IN "raw") > 0
                    THEN substring("raw" FOR position(decode('0a0a', 'hex') IN "raw") - 1)
                  ELSE "raw"
                END AS head_bytes
              FROM "mailbox"."principal_mail"
              WHERE "references" IS NULL
            ) sliced
          ) cleaned
        ) heads
      ) h
      WHERE pm."id" = h."id"
        AND h."references" IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_tenant_id_principal_id_message_id_idx"') IS NULL THEN
    CREATE INDEX "principal_mail_tenant_id_principal_id_message_id_idx"
      ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "message_id");
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_tenant_id_principal_id_created_at_id_asc_idx"') IS NULL THEN
    CREATE INDEX "principal_mail_tenant_id_principal_id_created_at_id_asc_idx"
      ON "mailbox"."principal_mail" ("tenant_id", "principal_id", "created_at" ASC, "id" ASC);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"mailbox"."principal_mail_refs_idx"') IS NULL THEN
    CREATE INDEX "principal_mail_refs_idx"
      ON "mailbox"."principal_mail" USING gin ("refs");
  END IF;
END $$;
