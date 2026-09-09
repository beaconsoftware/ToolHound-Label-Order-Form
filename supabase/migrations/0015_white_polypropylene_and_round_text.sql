-- Two changes, both from Metalcraft paperwork Ian read today.
--
-- 1. A third stock: .002" white polypropylene at 1.25" x 0.50".
--
--    Flagged rather than hidden: this is almost certainly the same physical
--    stock as premium_poly_pro, which is also .002" polypropylene and also
--    offered at 1.25" x 0.50". Metalcraft appear to name it two ways across
--    their documents. Both values exist because Ian asked for both, but if
--    they are one stock then identical orders will split across two type
--    values and the cost-over-time and COGS reconciliation has to undo it
--    later. Merging them once Metalcraft confirm is a later migration and a
--    one-line data update, which is why this is worth settling early.
--
-- 2. The 0.625" round anodized die carries no text. There is nowhere to put a
--    line of text beside the code on a label that is 0.625" across, so a text
--    order on that die is one Metalcraft cannot make. The form takes the
--    Custom Text option off the table for that size; this is the same rule in
--    the database, for the case where the form is bypassed.

alter table public.label_orders
  drop constraint if exists label_orders_label_type_known;

alter table public.label_orders
  add constraint label_orders_label_type_known check (
    label_type is null
    or label_type in (
      'premium_poly_pro',
      'white_polypropylene',
      'anodized_aluminum_3mil'
    )
  );

comment on column public.label_orders.label_type is
  'Label stock: premium_poly_pro, white_polypropylene or '
  'anodized_aluminum_3mil. Nullable because every order written before this '
  'column existed is poly pro -- that was the only stock the form could '
  'express -- and the document says so for rows with no value rather than '
  'leaving the material blank.';

-- The pairing rule, one row per size each stock is cut to. A size the stock is
-- not cut to never reaches the vendor, whatever the form did. Legacy rows carry
-- no type and are left alone.
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
    or (label_type = 'white_polypropylene'
        and label_width_in = 1.25 and label_height_in = 0.50)
    or (label_type = 'anodized_aluminum_3mil' and (
             (label_width_in = 1.25  and label_height_in = 0.50)
          or (label_width_in = 1.50  and label_height_in = 0.50)
          or (label_width_in = 0.625 and label_height_in = 0.625)))
  );

-- No text on the round die. Both halves of "text" are covered: the artwork
-- choice and the lines themselves, because a row could carry either without
-- the other and neither is printable at 0.625".
alter table public.label_orders
  drop constraint if exists label_orders_round_labels_carry_no_text;

alter table public.label_orders
  add constraint label_orders_round_labels_carry_no_text check (
    label_type is distinct from 'anodized_aluminum_3mil'
    or label_width_in is distinct from 0.625
    or (logo_choice <> 'custom_text' and text_lines is null)
  );
