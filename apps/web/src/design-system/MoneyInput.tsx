// Every money field in the product. Typed and shown in major units (EGP, two decimals); the value
// handed to the caller is always integer minor units, which is the only form that reaches the wire.

import { useEffect, useState } from "react";
import { TextInput } from "./fields.tsx";
import { majorToMinor, minorToMajorInput } from "../i18n/format.ts";

interface Props {
  label: string;
  hint?: string;
  /** Integer minor units, or null for an empty field. */
  valueMinor: number | null;
  /** Minor units, or null when the box is empty or holds something unusable. */
  onChangeMinor: (minor: number | null) => void;
  /** From `tenants.currency` via the session. Never assumed — the exponent is read from it. */
  currency: string;
  disabled?: boolean;
  required?: boolean;
  "data-testid"?: string;
}

/**
 * **The text is what the person typed; the minor units are what gets sent.**
 *
 * Both are kept, and that is the point rather than an implementation detail. Deriving the text back
 * from the number on every keystroke deletes a trailing decimal point the moment it is typed —
 * "1500." becomes "1500" and the field fights the person using it. The pair only re-syncs when the
 * caller changes the amount from outside, which is how a prefilled balance arrives.
 */
export function MoneyInput({
  label,
  hint,
  valueMinor,
  onChangeMinor,
  currency,
  disabled,
  required,
  "data-testid": testId,
}: Props) {
  const [text, setText] = useState(() =>
    valueMinor === null ? "" : minorToMajorInput(valueMinor, currency),
  );

  useEffect(() => {
    // Only when the outside value stopped matching what is in the box — otherwise every keystroke
    // would round-trip through the formatter and the caret would jump.
    const asMinor = majorToMinor(text, currency);
    if (valueMinor === asMinor) return;
    setText(valueMinor === null ? "" : minorToMajorInput(valueMinor, currency));
    // `text` is deliberately out of the dependency list: this effect exists to follow the *outside*
    // value, and including it would make the field re-derive itself while being typed into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueMinor, currency]);

  return (
    <TextInput
      label={label}
      hint={hint}
      numeric
      // `decimal` rather than `numeric`: a phone keypad without a decimal point cannot enter 12.50.
      inputMode="decimal"
      disabled={disabled}
      required={required}
      data-testid={testId}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onChangeMinor(majorToMinor(next, currency));
      }}
    />
  );
}
