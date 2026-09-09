-- The adhesive, per order, on the sheet Metalcraft works from.
--
-- 0015 shipped the row on the document reading from config with no default,
-- because the only two adhesives then in evidence disagreed and a hardcoded
-- value would have asserted a construction spec on every order. Ian's own
-- Label Orders tracker settles it: adhesive is per order, not per stock.
--
--   Pressure Sensitive Acrylic Adhesive   Shaw, Thomas Kanata, Millstone, NWT
--   0.002" MC78 Adhesive                  PCL Nisku
--   MC53FL Pressure Sensitive             Diavik
--   (blank)                               Phoenix Industrial
--
-- Note the two poly-pro orders that differ: Millstone gets acrylic and PCL
-- gets MC78 on the same stock. So this cannot be derived from label_type and
-- has to be its own column.
--
-- Staff-set, not asked on the form. It is agreed with Metalcraft, and a
-- customer filling in a label order has no way to know it. So the grant is to
-- authenticated only; anon never writes this.

alter table public.label_orders
  add column if not exists adhesive text;

comment on column public.label_orders.adhesive is
  'Adhesive stated on the vendor copy of the label order, e.g. "Pressure '
  'Sensitive Acrylic Adhesive" or "0.002\" MC78 Adhesive". Per order rather '
  'than per label_type: two poly pro orders in the same week used different '
  'adhesives. Staff-set from the dashboard; the public form does not ask for '
  'it. Null prints as a dash rather than a guess.';

-- Shape only. Long enough for the real values, short enough that a paste
-- accident does not end up on a supplier document.
alter table public.label_orders
  drop constraint if exists label_orders_adhesive_length;

alter table public.label_orders
  add constraint label_orders_adhesive_length check (
    adhesive is null or (length(adhesive) between 1 and 120)
  );

grant insert (adhesive), update (adhesive) on public.label_orders to authenticated;

-- Populate the live orders from the tracker. Each update is scoped to its
-- order_ref and to adhesive still being unset, so re-running changes nothing
-- and a value edited by hand since is never overwritten.
update public.label_orders
set adhesive = '0.002" MC78 Adhesive'
where order_ref = 'THL-MTTFC9AS-YKAZSK' and adhesive is null;

update public.label_orders
set adhesive = 'Pressure Sensitive Acrylic Adhesive'
where order_ref = 'THL-MTTFIK70-FHDUTW' and adhesive is null;

update public.label_orders
set adhesive = 'Pressure Sensitive Acrylic Adhesive'
where order_ref = 'THL-MTTFUC53-GUVFT7' and adhesive is null;

-- Phoenix Industrial (THL-MTTFO4ZS-SRNP2M) is deliberately not here. The
-- tracker leaves its adhesive blank, and its line is a stock ToolHound
-- equipment label rather than a made-to-order construction. Guessing one for
-- it would be the thing this column exists to avoid.
