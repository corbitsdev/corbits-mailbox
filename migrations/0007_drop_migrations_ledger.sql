-- Drops the ledger table 0.1.0's runner kept. Every replay reaches this, so
-- it drops only that table's exact shape.
DO $$
BEGIN
  IF (
    SELECT array_agg(column_name::text ORDER BY column_name)
    FROM information_schema.columns
    WHERE table_schema = 'mailbox' AND table_name = 'corbits_mailbox_migrations'
  ) = ARRAY['applied_at', 'checksum', 'id'] THEN
    DROP TABLE "mailbox"."corbits_mailbox_migrations";
  END IF;
END $$;
