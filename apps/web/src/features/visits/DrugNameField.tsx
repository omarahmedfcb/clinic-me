// The prescription's medication-name field: type an English or Arabic commercial name, or the
// scientific name, pick from the list, and the English commercial name is what lands in the field.
// Anything typed is still accepted as is, and this clinic's own earlier prescriptions are listed too.

import { useEffect, useRef, useState } from "react";
import { TextInput } from "../../design-system/fields.tsx";
import { suggestDrugs, suggestMedications } from "./draft-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;
interface Option {
  name: string;
  detail: string;
}

const DEBOUNCE_MS = 200;

export function DrugNameField({
  label,
  value,
  authFetch,
  appointmentId,
  onChange,
}: {
  label: string;
  value: string;
  authFetch: AuthFetch;
  appointmentId: string;
  onChange: (name: string) => void;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  function search(text: string): void {
    clearTimeout(timer.current);
    const query = text.trim();
    if (query === "") {
      latest.current += 1;
      setOptions([]);
      return;
    }
    timer.current = setTimeout(() => {
      const ticket = (latest.current += 1);
      void Promise.all([
        suggestMedications(authFetch, appointmentId, query),
        suggestDrugs(authFetch, appointmentId, query),
      ]).then(([history, drugs]) => {
        // A slower answer to an older keystroke must not replace the newer list.
        if (ticket !== latest.current) return;
        const seen = new Set<string>();
        const merged: Option[] = [];
        for (const name of history.slice(0, 4)) {
          if (!seen.has(name.toLowerCase())) merged.push({ name, detail: "" });
          seen.add(name.toLowerCase());
        }
        for (const drug of drugs) {
          if (seen.has(drug.name.toLowerCase())) continue;
          seen.add(drug.name.toLowerCase());
          merged.push({ name: drug.name, detail: [drug.arabic, drug.scientific].filter(Boolean).join(" · ") });
        }
        setOptions(merged);
        setActive(-1);
        setOpen(merged.length > 0);
      });
    }, DEBOUNCE_MS);
  }

  function choose(option: Option): void {
    onChange(option.name);
    setOpen(false);
    setOptions([]);
    latest.current += 1;
  }

  return (
    <div className="relative">
      <TextInput
        label={label}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value);
          search(event.target.value);
        }}
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(options.length > 0)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((at) => Math.min(at + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((at) => Math.max(at - 1, 0));
          } else if (event.key === "Enter" && active >= 0) {
            event.preventDefault();
            const picked = options[active];
            if (picked !== undefined) choose(picked);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          role="listbox"
          data-testid="drug-options"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {options.map((option, index) => (
            <li
              key={option.name}
              role="option"
              aria-selected={index === active}
              // mousedown, not click: the input's blur would close the list before a click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={`cursor-pointer px-3 py-2 text-sm ${index === active ? "bg-primary-soft/40" : "hover:bg-surface-sunken"}`}
            >
              <span className="block text-ink" dir="ltr">{option.name}</span>
              {option.detail !== "" && <span className="block text-xs text-ink-muted">{option.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
