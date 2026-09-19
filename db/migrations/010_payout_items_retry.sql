-- 010 — Allow a payment to be retried after its payout failed.
--
-- `ux_payout_items_payment` was unique on payment_id across ALL payouts, which
-- reads as "a payment may only ever be settled by one payout". That is right
-- for payouts that are live or settled, and wrong for ones that failed.
--
-- The effect: a failed payout returned the money to AVAILABLE but left its item
-- row behind, so the payment became permanently unpayable — spendable in the
-- ledger, invisible to every future selection. Money stranded by an index.
--
-- An index predicate cannot contain a subquery, so the payout's liveness is
-- carried on the item row itself and kept in step by a trigger. The partial
-- unique index then enforces the real invariant — no payment is settled twice —
-- while permitting a retry after failure.

ALTER TABLE finance.payout_items
    ADD COLUMN is_live BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill from current payout state.
UPDATE finance.payout_items pi
   SET is_live = (po.status <> 'FAILED')
  FROM finance.payouts po
 WHERE po.id = pi.payout_id;

DROP INDEX finance.ux_payout_items_payment;

CREATE UNIQUE INDEX ux_payout_items_payment_live
    ON finance.payout_items(payment_id)
    WHERE is_live;

-- Keep is_live in step with the payout it belongs to.
CREATE OR REPLACE FUNCTION finance.sync_payout_item_liveness()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE finance.payout_items
           SET is_live = (NEW.status <> 'FAILED')
         WHERE payout_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payout_item_liveness
    AFTER UPDATE OF status ON finance.payouts
    FOR EACH ROW EXECUTE FUNCTION finance.sync_payout_item_liveness();
