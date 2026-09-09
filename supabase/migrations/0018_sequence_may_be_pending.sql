-- An order may legitimately not have a sequence yet.
--
-- 0009 required every row to carry one, on the reasonable assumption that a
-- label order without numbering is incomplete. Phoenix Industrial is the case
-- that breaks it: their next run has to continue from where the last one
-- ended, and only Metalcraft know the last serial produced. ToolHound's own
-- invoices say 35001-40000 in 2022 and 40001-45000 in June 2025, so the answer
-- is probably 45001, but "probably" is not a number to print on a production
-- document.
--
-- Until the supplier confirms it, the honest state is blank. The order was
-- carrying seq_start '0001', which with 9,000 labels would have printed
-- 0001-9000 and re-issued numbers already on Phoenix's tools. A placeholder
-- that looks valid is worse than an empty field, which is the whole reason
-- for this migration.
--
-- What is lost: a bypassed form could now insert an order with no sequence.
-- That is an acceptable trade. The form still requires the field, and the
-- vendor copy states "to be confirmed" in the serialised column rather than
-- silently showing nothing, so a missing sequence is visible on the document
-- itself rather than resting on a database check.

alter table public.label_orders
  drop constraint if exists label_orders_has_a_sequence;

-- The shape check stays: whatever is there must still be a usable sequence.
-- Only its presence became optional.

update public.label_orders
set seq_start = null
where order_ref = 'THL-MTTFO4ZS-SRNP2M'
  and company_name = 'Phoenix Industrial Maintenance Ltd.'
  and seq_start = '0001';

grant update (seq_start) on public.label_orders to authenticated;
