-- The real catalogue, from ToolHound's own invoice history.
--
-- 0013 recorded two label types and three sizes between them. The Sales by
-- Customer Detail export for January 2022 to June 2026 shows four materials
-- and seven sizes, and 0013's pairing rule would have rejected several orders
-- ToolHound has actually shipped -- five anodized aluminium orders at
-- 1.25" x 0.50" among them. This is that gap closed.
--
-- The type values change shape as well as widen. 'anodized_aluminum_circular'
-- described one die as if it were a material; the material is anodized
-- aluminium foil at 3 mil, and circular is one of the three sizes it is cut
-- to. Renaming it is safe here and only here: label_orders is empty, and no
-- order has ever carried a label_type. Once rows exist this becomes a data
-- migration instead.
--
-- Deliberately excluded, and this is a decision rather than an omission: the
-- Universal Micro RFID label at 1 7/8" x 5/8" (Newgold, September 2024) and
-- the bespoke 5 mil matte PHA laminate (Bureau Veritas, April 2022). One order
-- each, years apart, and both are a conversation with Metalcraft rather than
-- a form field.

do $$
begin
  if exists (select 1 from public.label_orders where label_type is not null) then
    raise exception
      'label_orders already carries label_type values; 0014 renames them and '
      'must be rewritten as a data migration before it can run';
  end if;
end $$;

comment on column public.label_orders.label_type is
  'Label stock: premium_poly_pro, anodized_aluminum_3mil or aluminum_foil. '
  'Nullable because every order written before this column existed is poly '
  'pro -- that was the only stock the form could express -- and the document '
  'says so for rows with no value rather than leaving the material blank.';

alter table public.label_orders
  drop constraint if exists label_orders_label_type_known;

alter table public.label_orders
  add constraint label_orders_label_type_known check (
    label_type is null
    or label_type in (
      'premium_poly_pro',
      'anodized_aluminum_3mil',
      'aluminum_foil'
    )
  );

-- The pairing rule, one row per size ToolHound has invoiced. A size the stock
-- is not cut to never reaches the vendor, whatever the form did. Legacy rows
-- carry no type and are left alone.
--
-- 0.625 round is stored as 0.625 x 0.625 because the columns are a width and a
-- height. The document renders it as a diameter, which is how a round die is
-- specified; the shape lives in config.js next to the size it belongs to.
alter table public.label_orders
  drop constraint if exists label_orders_label_type_size_paired;

alter table public.label_orders
  add constraint label_orders_label_type_size_paired check (
    label_type is null
    or label_width_in is null
    or label_height_in is null
    or (label_type = 'premium_poly_pro' and (
             (label_width_in = 1.50  and label_height_in = 0.75)
          or (label_width_in = 1.25  and label_height_in = 0.50)
          or (label_width_in = 0.75  and label_height_in = 0.75)
          or (label_width_in = 1.00  and label_height_in = 1.00)))
    or (label_type = 'anodized_aluminum_3mil' and (
             (label_width_in = 1.25  and label_height_in = 0.50)
          or (label_width_in = 1.50  and label_height_in = 0.50)
          or (label_width_in = 0.625 and label_height_in = 0.625)))
    or (label_type = 'aluminum_foil'
        and label_width_in = 1.50 and label_height_in = 0.75)
  );
