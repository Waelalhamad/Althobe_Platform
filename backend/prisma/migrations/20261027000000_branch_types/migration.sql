-- Libya as a branch (developer report F-04). New enum values commit before anything uses them.
-- TRANSIT: where goods sent between branches are while on the road.
ALTER TYPE "location_kind" ADD VALUE 'TRANSIT';
-- Pieces sent that never arrived.
ALTER TYPE "movement_type" ADD VALUE 'SHIPPING_LOSS';
-- The receiving end of a shipment scans what arrived.
ALTER TYPE "scan_session_kind" ADD VALUE 'SHIPMENT_IN';
