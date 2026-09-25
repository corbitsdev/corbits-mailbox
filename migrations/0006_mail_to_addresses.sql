-- Recipients, cached like "references" so a listing can render "to".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'principal_mail'
      AND column_name = 'to_addresses'
  ) THEN
    ALTER TABLE "mailbox"."principal_mail" ADD COLUMN "to_addresses" jsonb;
  END IF;
END $$;
