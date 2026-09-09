-- The label order document's reference is ToolHound's own quote number.
--
-- Until now the only reference on an order was the generated THL- ref, which
-- is meaningful to us and to nobody else. The document that goes to Metalcraft
-- now carries the quote number instead, because that is the number the
-- customer, the vendor and accounting all already recognise, and because
-- Metalcraft echo it back on every document after their quote.
--
-- Nullable on purpose. Every order already in the table predates the field,
-- and a NOT NULL column would either reject them or need a fabricated value.
-- The document falls back to the internal reference when this is empty, so an
-- older order still prints with something on it.
--
-- Not unique on purpose either, and this is a known gap rather than an
-- oversight: quote numbers are reused in practice. GC-24-175A appears on both
-- the PCL Nisku and the NWT orders, and PCL's own purchase order cites it "for
-- item pricing only", which is a rate card referenced twice rather than one
-- order. Enforcing uniqueness here would reject legitimate data until that is
-- resolved upstream. Ian owns that decision; when it lands, either a per-order
-- suffix or a unique index belongs in a later migration.

alter table public.label_orders
  add column if not exists quote_number text;

comment on column public.label_orders.quote_number is
  'ToolHound quote number. Printed as the reference on the label order '
  'document and expected back on Metalcraft''s paperwork. Not unique: quote '
  'numbers are reused across orders today.';

-- Shape only, no uniqueness. Real quote numbers look like GC-24-175A and
-- GC-26-175D, so the constraint allows letters, digits and hyphens and just
-- keeps out whitespace, empty strings and anything long enough to be a
-- paste accident.
alter table public.label_orders
  drop constraint if exists label_orders_quote_number_shape;

alter table public.label_orders
  add constraint label_orders_quote_number_shape check (
    quote_number is null
    or quote_number ~ '^[A-Za-z0-9][A-Za-z0-9/-]{0,38}$'
  );

-- The public form writes it, so the anon role needs the column. Column-level
-- grants are additive to the existing INSERT policy; without this the insert
-- fails with "permission denied for table label_orders" and nothing about the
-- error names the column.
grant insert (quote_number) on public.label_orders to anon;
grant insert (quote_number), update (quote_number) on public.label_orders to authenticated;
