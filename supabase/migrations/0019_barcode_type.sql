-- Two forms, one per code type, and the order records which it came from.
--
-- Barcode symbology was never a question on the form and is not becoming one.
-- Sales hands the customer the link for what they are buying, each page
-- declares its own variant, and this column is where that lands so the sheet
-- Metalcraft works from states it.
--
-- Only two values, and neither names a symbology. Metalcraft's own paperwork
-- for order 774159 records "QR" and "QR HRI" and nothing else, so a ToolHound
-- document asserting "Code 128" would be an invention. "Linear barcode" is
-- what ToolHound say and all ToolHound can honestly say.
--
-- Nullable: the four orders already in the table were submitted by the single
-- form that predates the split, and nothing in them records which code was
-- printed. Backfilling would be guessing -- the tracker calls the NWT order
-- "QR code and sequence only", but that is one row of a spreadsheet and the
-- other three say nothing. They show a dash until someone who knows sets them.

alter table public.label_orders
  add column if not exists barcode_type text;

comment on column public.label_orders.barcode_type is
  'Which form the order came from: linear or qr. Printed on the vendor copy as '
  '"Linear barcode" or "QR code". Never a specific symbology name -- nothing '
  'in the supplier''s paperwork states one. Null on the four orders that '
  'predate the two-form split.';

alter table public.label_orders
  drop constraint if exists label_orders_barcode_type_known;

alter table public.label_orders
  add constraint label_orders_barcode_type_known check (
    barcode_type is null or barcode_type in ('linear', 'qr')
  );

-- The public form writes it, so anon needs the column, same as every other
-- field the form submits.
grant insert (barcode_type) on public.label_orders to anon;
grant insert (barcode_type), update (barcode_type) on public.label_orders to authenticated;

-- quote_number is NOT dropped. The form stopped asking for it because quote
-- numbers duplicate across orders -- GC-24-175A is on the PCL order and the
-- NWT order both -- so it was never the key it looked like. But three live
-- orders carry one, and it is the only thread back to the quote Graham sent,
-- so the column and its data stay and only the form question went away.
--
-- adhesive is NOT dropped either, for the same reason: the document no longer
-- states it, because it follows from the material and is already right by
-- default at Metalcraft, but the three recorded values cost nothing to keep
-- and dropping a column is irreversible.
