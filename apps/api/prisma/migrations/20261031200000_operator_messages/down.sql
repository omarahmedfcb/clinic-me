-- Reverses 20261031200000_operator_messages. Refuses over sent messages: they are records, and down is for an undeployed branch.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM operator_messages) THEN
    RAISE EXCEPTION 'operator messages down: messages have been sent, and a sent message is a record, not scaffolding.';
  END IF;
END $$;

DROP FUNCTION platform_operator_messages();
DROP FUNCTION deliver_operator_message(uuid);
DROP TABLE "operator_message_reads";
DROP TABLE "operator_message_recipients";
DROP TABLE "operator_messages";
DROP TYPE "OperatorMessageAudience";

DELETE FROM _prisma_migrations WHERE migration_name = '20261031200000_operator_messages';
