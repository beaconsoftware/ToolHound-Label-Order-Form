-- Custom text lines go from 10 characters to 18.
--
-- Ten was the limit the old Microsoft Forms sheet used, and this form copied
-- it. Real orders want more: 18 is what Ian asked for, and it is the width a
-- line of copy can actually take on the label alongside the barcode.
--
-- Still three lines. Only the per-line width changes.
--
-- The function is `create or replace`, so this migration is replayable and the
-- constraint that references it does not need dropping. Widening a check is
-- also safe against existing rows by definition: everything that satisfied
-- 10 satisfies 18.
--
-- Deploy order matters. This has to land before the frontend that allows 18,
-- or a customer typing an eleventh character gets a constraint violation on
-- submit and nothing in the error names the field.

create or replace function public.label_text_lines_valid(lines jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lines is null or (
    jsonb_typeof(lines) = 'array'
    and jsonb_array_length(lines) <= 3
    and (
      select coalesce(bool_and(length(v) <= 18), true)
      from jsonb_array_elements_text(lines) v
    )
  );
$$;

comment on function public.label_text_lines_valid(jsonb) is
  'Mirrors the form rule: at most three custom text lines, each at most 18 characters.';
