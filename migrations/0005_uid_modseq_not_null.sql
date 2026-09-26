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
-- management table, so it goes.
DROP TABLE IF EXISTS "mailbox"."mailbox";
