-- The threading headers, cached so the list projection never loads "raw".
-- The backfill runs only in the replay that adds the columns: it slices the
-- header section out of "raw" as bytea and strips NUL bytes before
-- convert_from, since Postgres text cannot hold 0x00.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'message_id'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail"
      ADD COLUMN "message_id" text,
      ADD COLUMN "in_reply_to" text;
    UPDATE "mailbox"."principal_mail" AS pm
      SET "message_id" = h."message_id", "in_reply_to" = h."in_reply_to"
      FROM (
        SELECT "id",
          substring(head from '(?ni)^Message-ID:[[:space:]]*(<[^<>]+>)') AS "message_id",
          substring(head from '(?ni)^In-Reply-To:[[:space:]]*(<[^<>]+>)') AS "in_reply_to"
        FROM (
          SELECT "id",
            replace(
              convert_from(clean_bytes, 'LATIN1'),
              chr(13) || chr(10), chr(10)
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
              WHERE "message_id" IS NULL AND "in_reply_to" IS NULL
            ) sliced
          ) cleaned
        ) heads
      ) h
      WHERE pm."id" = h."id"
        AND (h."message_id" IS NOT NULL OR h."in_reply_to" IS NOT NULL);
  END IF;
END $$;
