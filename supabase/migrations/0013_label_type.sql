-- A second label stock: .003" matte anodized aluminium circular, 0.625" square
-- die. Two things had to change for it.
--
-- 1. Precision. label_width_in and label_height_in were numeric(5,2), so
--    Postgres would silently store 0.625 as 0.63. The vendor document renders
--    the die size to four decimals, which means Metalcraft would have received
--    0.6300 x 0.6300 in and cut to it. numeric(6,3) holds the real value.
--
-- 2. The size belongs to the stock. 0.625" square exists only on the circular
--    aluminium; the two poly pro sizes exist only on poly pro. Recording the
--    type and pairing it with the size in the database means the form is not
--    the only thing standing between a mismatched order and the printer.

alter table public.label_orders
  alter column label_width_in  type numeric(6,3),
  alter column label_height_in type numeric(6,3);

comment on column public.label_orders.label_width_in is
  'Label width in inches, to three decimals. Three, not two, because the '
  '0.625" anodized aluminium die is not representable at two and would round '
  'to 0.63 on the document the vendor cuts from.';
comment on column public.label_orders.label_height_in is
  'Label height in inches, to three decimals. See label_width_in.';

alter table public.label_orders
  add column if not exists label_type text;

comment on column public.label_orders.label_type is
  'Label stock: premium_poly_pro or anodized_aluminum_circular. Nullable '
  'because every order written before this column existed is poly pro -- that '
  'was the only stock the form could express -- and the document says so for '
  'rows with no value rather than leaving the material blank.';

-- Shape, so a typo cannot become a material nobody stocks. Kept as a check
-- rather than an enum: adding a stock should be one migration, not a type
-- rewrite.
alter table public.label_orders
  drop constraint if exists label_orders_label_type_known;

alter table public.label_orders
  add constraint label_orders_label_type_known check (
    label_type is null
    or label_type in ('premium_poly_pro', 'anodized_aluminum_circular')
  );

-- The pairing rule. A size that the stock is not made in never reaches the
-- vendor, whatever the form did. Legacy rows carry no type and are left alone.
alter table public.label_orders
  drop constraint if exists label_orders_label_type_size_paired;

alter table public.label_orders
  add constraint label_orders_label_type_size_paired check (
    label_type is null
    or label_width_in is null
    or label_height_in is null
    or (label_type = 'premium_poly_pro' and (
          (label_width_in = 1.50 and label_height_in = 0.75)
       or (label_width_in = 1.25 and label_height_in = 0.50)))
    or (label_type = 'anodized_aluminum_circular'
        and label_width_in = 0.625 and label_height_in = 0.625)
  );

-- The public form writes the type, so anon needs the column. Additive to the
-- existing INSERT policy; without it the insert fails with "permission denied
-- for table label_orders" and the error names no column.
grant insert (label_type) on public.label_orders to anon;
grant insert (label_type), update (label_type) on public.label_orders to authenticated;
