-- Phase 1 addendum — SCHEMA-DECISIONS.md D19 (bilingual patient names, and how search finds them).
--
-- Splits patients.full_name into full_name_ar plus an optional full_name_en, and adds the two
-- derived search columns D19 specifies. This is a RENAME, not an additive change: every existing
-- patient name is Arabic, so full_name becomes full_name_ar in place and no data moves.
--
-- Only patients are touched. users.full_name is staff, not patients, and is outside D19's scope.
--
--
-- WHY THE NORMALISATION IS A FUNCTION, AND WHAT THAT COSTS
--
-- normalize_arabic_name() is IMMUTABLE and feeds a GENERATED ALWAYS ... STORED column. Postgres
-- does not recompute stored generated values when a function body changes, and it will not stop
-- anyone from replacing it: CREATE OR REPLACE on this function silently leaves existing rows
-- holding values computed under the old rules, with no error and no warning.
--
-- The supported way to change these rules is therefore: drop name_search_ar, re-add it, and let
-- Postgres recompute every row. That cost is exactly why D19 keeps the volatile half of the
-- design -- transliteration, which we expect to improve repeatedly -- OUT of this column and in
-- the application-maintained name_search_latin instead.
--
--
-- WHY THE CHARACTERS ARE ESCAPES AND NOT LITERALS
--
-- Every Arabic character below is written as a U&'\XXXX' codepoint escape. Combining marks pasted
-- literally into a migration are invisible on screen and unreviewable in a diff -- you cannot tell
-- a fatha from a damma from nothing at all. As escapes, each one can be checked against the table
-- in D19 by eye.
--
--
-- WHAT THE RULES MERGE, AND WHAT THEY WRONGLY MERGE
--
-- The nine rules are enumerated in D19 with their false positives. Two of them knowingly collapse
-- genuinely different names:
--
--   teh marbuta -> heh      عبده (m) / عبدة (f)
--   alef maksura -> yeh     حسني (m) / حسنى (f),  يسري (m) / يسرى (f)
--
-- These are accepted on frequency: ى is the NATIVE final spelling of مصطفى, يحيى, منى and على, so
-- omitting the rule would fail to find the most common Egyptian names, constantly. The collisions
-- are survivable only because of two constraints recorded as load-bearing in D19 -- name_search_ar
-- carries no UNIQUE constraint and never drives an automatic merge, and search results display
-- full_name_ar rather than the normalised form, alongside phone and date of birth. Remove either
-- of those and these two rules become unsafe.

CREATE OR REPLACE FUNCTION normalize_arabic_name(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      translate(
        translate(
          input,
          -- DELETED. Marks and invisibles that carry no identity.
          -- tashkeel and Quranic marks U+064B..U+065F, and the superscript alef U+0670
          U&'\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659'
            || U&'\065A\065B\065C\065D\065E\065F\0670'
          -- tatweel/kashida U+0640 (decorative elongation), standalone hamza U+0621
            || U&'\0640\0621'
          -- zero-width space/non-joiner/joiner, LRM, RLM, Arabic letter mark. These arrive
          -- invisibly in names pasted out of WhatsApp and would otherwise defeat exact matching.
            || U&'\200B\200C\200D\200E\200F\061C',
          ''
        ),
        -- MAPPED, one-to-one and in order:
        --   أ  إ  آ  ٱ   ->  ا      alef forms to bare alef
        --   ة           ->  ه      teh marbuta to heh
        --   ى           ->  ي      alef maksura to yeh
        --   ؤ  ئ        ->  و  ي   hamza carriers to their base letters
        --   ی  ک        ->  ي  ك   Farsi yeh and keheh, which arrive from non-Arabic keyboards
        U&'\0623\0625\0622\0671\0629\0649\0624\0626\06CC\06A9',
        U&'\0627\0627\0627\0627\0647\064A\0648\064A\064A\0643'
      ),
      -- Runs of whitespace collapse to one space; btrim removes the ends.
      '\s+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION normalize_arabic_name(text) IS
  'Normalises an Arabic name for search (SCHEMA-DECISIONS.md D19). Feeds the generated column '
  'patients.name_search_ar. Replacing this function does NOT recompute stored values -- to change '
  'the rules, drop and re-add the column.';

-- Generated-column expressions are evaluated as the inserting role. PUBLIC holds EXECUTE on new
-- functions by default, but every other function in this schema grants it explicitly, so this one
-- does too rather than depending on a default nobody can see.
GRANT EXECUTE ON FUNCTION normalize_arabic_name(text) TO clinic_os_app;


-- Trigram matching for both search columns. pg_trgm ships with the postgres:16 image; creating the
-- extension needs the migration superuser, which is why it belongs here and not in application code.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


ALTER TABLE patients RENAME COLUMN full_name TO full_name_ar;
ALTER INDEX patients_tenant_id_full_name_idx RENAME TO patients_tenant_id_full_name_ar_idx;

ALTER TABLE patients ADD COLUMN full_name_en TEXT;

-- The stable half: pure character normalisation, computed by Postgres so it cannot drift from
-- full_name_ar no matter what writes the row.
ALTER TABLE patients
  ADD COLUMN name_search_ar TEXT GENERATED ALWAYS AS (normalize_arabic_name(full_name_ar)) STORED;

-- The volatile half: transliteration of the Arabic name plus the normalised full_name_en, written
-- by the application and rebuilt by a backfill script when the transliteration table improves.
ALTER TABLE patients ADD COLUMN name_search_latin TEXT;

COMMENT ON COLUMN patients.name_search_ar IS
  'Search key only (SCHEMA-DECISIONS.md D19). Never UNIQUE, never drives an automatic merge.';

CREATE INDEX patients_name_search_ar_trgm_idx
  ON patients USING GIN (name_search_ar gin_trgm_ops);

CREATE INDEX patients_name_search_latin_trgm_idx
  ON patients USING GIN (name_search_latin gin_trgm_ops);
