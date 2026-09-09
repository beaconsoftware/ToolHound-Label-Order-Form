-- An artwork option meaning "the serial number and nothing else".
--
-- 0015 added the round-die rule NOT VALID because a real order broke it, and
-- said the fix was an option the form did not have. This is that option.
--
-- The gap was not cosmetic. NWT Forest Management Division's 0.625" round
-- asset tags carry a serial number, no logo and no text. The form offered
-- Custom Logo, Custom Text and ToolHound Logo, made the question required,
-- and so the customer chose Custom Text and typed the words "NO TEXT". Order
-- THL-MTTFUC53-GUVFT7 would have printed NO TEXT on 500 aluminium labels.
--
-- Widening logo_choice, correcting that row and validating the constraint all
-- belong in one migration: the correction is only expressible once the value
-- exists, and the constraint can only be validated once the row is corrected.

alter table public.label_orders
  drop constraint if exists label_orders_logo_choice_check;

alter table public.label_orders
  add constraint label_orders_logo_choice_check check (
    logo_choice in ('custom_logo', 'custom_text', 'toolhound_logo', 'serial_only')
  );

comment on column public.label_orders.logo_choice is
  'What goes on the label besides the code: custom_logo (file supplied), '
  'custom_text (lines in text_lines), toolhound_logo, or serial_only for a '
  'label carrying the serial number and nothing else.';

-- A serial-only label has no artwork, so it must carry neither a file nor
-- text. Without this the new value would be a third way to say custom_text.
alter table public.label_orders
  drop constraint if exists label_orders_serial_only_is_bare;

alter table public.label_orders
  add constraint label_orders_serial_only_is_bare check (
    logo_choice <> 'serial_only'
    or (text_lines is null and logo_file_name is null and logo_file_data is null)
  );

-- The correction. Scoped to the one order and to the exact wrong value, so it
-- cannot touch anything else and cannot fire twice.
update public.label_orders
set logo_choice = 'serial_only',
    text_lines = null
where order_ref = 'THL-MTTFUC53-GUVFT7'
  and logo_choice = 'custom_text'
  and text_lines = '["NO TEXT"]'::jsonb;

-- With that row corrected the round-die rule holds for every row, so it stops
-- being a guard on new writes only and becomes a guarantee about the table.
-- If any other violating row has appeared since, this fails and the migration
-- rolls back rather than quietly leaving the constraint unvalidated.
alter table public.label_orders
  validate constraint label_orders_round_labels_carry_no_text;

-- The public form writes the new value through the existing logo_choice grant,
-- so there is nothing to grant here.
