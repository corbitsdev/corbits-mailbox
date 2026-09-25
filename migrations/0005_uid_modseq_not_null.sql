-- The native store sets uid and modseq on every write, so both can be
-- NOT NULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'uid' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail" ALTER COLUMN "uid" SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'modseq' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail" ALTER COLUMN "modseq" SET NOT NULL;
  END IF;
END $$;

-- 0004 has already carried folder and \Seen out of the pre-native
-- management table, so it goes. Every replay reaches this, so it drops only
-- that table's exact shape and leaves a host's own "mailbox"."mailbox" alone.
DO $$
BEGIN
  IF (
    SELECT array_agg(column_name::text ORDER BY column_name)
    FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'mailbox'
  ) = ARRAY['archived_at', 'assignee', 'classification', 'id', 'principal_id',
            'priority', 'read_at', 'status', 'tenant_id', 'trashed_at'] THEN
    DROP TABLE "mailbox"."mailbox";
  END IF;
END $$;
