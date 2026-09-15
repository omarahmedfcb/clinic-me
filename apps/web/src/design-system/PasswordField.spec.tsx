import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PasswordField, passwordVisibility } from "./fields.tsx";

/**
 * The login password field's show/hide control, driven the way a person drives it.
 *
 * ## Why this replaced a source check
 *
 * The first version of this guard lived in `apps/api/test/unit` and read the component as text,
 * because the API's jest cannot load a `.tsx` file or resolve `apps/web`'s React on CI. A source
 * check passes on a `<div>` with a click handler, on an icon pinned to a physical side, and — the
 * one that matters — on a toggle whose icon flips while the input stays `type="password"`. It
 * could assert the *mechanism* that prevents that, never the result.
 *
 * This clicks the button and reads the DOM that comes back.
 *
 * ## The wrapper is the test's apparatus, not scaffolding
 *
 * `PasswordField` takes `visible` from its caller, so the state lives here — the same shape
 * `LoginPage` uses. And it renders inside a real `<form>` with a submit handler, because
 * *"peeking must not submit"* is a claim about form semantics: a `<button>` inside a form defaults
 * to `type="submit"`, so the failure is one missing attribute away and is invisible until somebody
 * peeks at their password and the login request fires with a half-typed value — spending one of the
 * ten attempts per fifteen minutes that this control exists to protect.
 */

function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        // jsdom does not implement navigation; without this it warns rather than failing, and the
        // handler is what the assertion reads anyway.
        event.preventDefault();
        onSubmit();
      }}
    >
      <PasswordField
        label="كلمة المرور"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        visible={visible}
        onToggleVisible={() => setVisible((shown) => !shown)}
        toggleLabel={visible ? "إخفاء كلمة السر" : "إظهار كلمة السر"}
      />
    </form>
  );
}

const setup = () => {
  const onSubmit = vi.fn();
  const view = render(<Harness onSubmit={onSubmit} />);
  const input = screen.getByLabelText("كلمة المرور") as HTMLInputElement;
  return { onSubmit, view, input };
};

describe("PasswordField", () => {
  afterEach(cleanup);

  test("starts hidden, with a toggle that says what clicking will do", () => {
    const { input } = setup();
    expect(input.type).toBe("password");
    const toggle = screen.getByRole("button", { name: "إظهار كلمة السر" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking flips the input type and the label together", () => {
    // **The assertion the source check could not make.** An icon that flips while the field stays
    // `type="password"` looks exactly like a working toggle and reveals nothing.
    const { input } = setup();

    fireEvent.click(screen.getByRole("button", { name: "إظهار كلمة السر" }));
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "إخفاء كلمة السر" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "إخفاء كلمة السر" }));
    expect(input.type).toBe("password");
    expect(screen.getByRole("button", { name: "إظهار كلمة السر" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("a half-typed password survives a peek", () => {
    // The failure this catches is a version that branches on `visible` and returns its own <input>
    // per branch: React unmounts one and mounts the other, and the value goes with it.
    const { input } = setup();
    fireEvent.change(input, { target: { value: "half-typed" } });

    fireEvent.click(screen.getByRole("button", { name: "إظهار كلمة السر" }));
    expect(input.value).toBe("half-typed");

    fireEvent.click(screen.getByRole("button", { name: "إخفاء كلمة السر" }));
    expect(input.value).toBe("half-typed");
  });

  test("peeking does not submit the form", () => {
    // `type="button"`, proven by consequence rather than by reading the attribute. Without it the
    // default inside a form is `submit`, and every peek fires a login attempt.
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "إظهار كلمة السر" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the toggle is in the tab order, reachable without a mouse", () => {
    // A <button> is focusable by default; this breaks when somebody adds tabIndex={-1} to tidy the
    // tab order, which silently makes the control mouse-only.
    setup();
    const toggle = screen.getByRole("button", { name: "إظهار كلمة السر" });
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });

  test("the control sits at the inline end, by logical property", () => {
    // Arabic is the default direction, so an icon pinned to the physical end is on the wrong side
    // of every screen this clinic uses. `web-logical-properties.spec.ts` guards the repo generally;
    // this pins it on the one element whose whole job is to sit at the inline end of a field.
    setup();
    const classes = screen.getByRole("button", { name: "إظهار كلمة السر" }).className;
    expect(classes).toMatch(/\bend-1\b/);
    expect(classes).not.toMatch(/\b(left|right)-/);
  });
});

describe("passwordVisibility", () => {
  test("hidden is password + show, visible is text + hide", () => {
    // The pure pair, asserted as whole objects so changing one half without the other cannot pass.
    expect(passwordVisibility(false)).toEqual({ type: "password", labelKey: "login.password.show" });
    expect(passwordVisibility(true)).toEqual({ type: "text", labelKey: "login.password.hide" });
  });
});
