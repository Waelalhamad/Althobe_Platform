-- Gifts (developer report F-06): their own movement and scan session, apart from damage. New
-- enum values are committed in their own migration before anything uses them.
ALTER TYPE "movement_type" ADD VALUE 'GIFT';
ALTER TYPE "scan_session_kind" ADD VALUE 'GIFT';
