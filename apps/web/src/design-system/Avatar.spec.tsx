import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../i18n/locale-context.tsx";
import { Avatar, initialsOf } from "./Avatar.tsx";

/**
 * The avatar, and the initials it falls back to.
 *
 * Two rules, and each exists because the obvious implementation gets a real seeded name wrong.
 * **First and last word, not the first two**, because Arabic names carry a father's name: the first
 * two words of «أحمد عبد الرحمن الشناوي» are أ ع. And **the definite article is dropped from the
 * family name**, because «الشناوي» and «الديب» both start with ا — every second person in the seed
 * would otherwise reduce to the same two letters.
 */

afterEach(cleanup);

describe("initials", () => {
  test("first and last word, in Arabic", () => {
    expect(initialsOf("أحمد عبد الرحمن الشناوي")).toBe("أش");
    expect(initialsOf("منى سيد فهمي")).toBe("مف");
  });

  test("first and last word, in English", () => {
    expect(initialsOf("Mona Sayed Fahmy")).toBe("MF");
  });

  test("one word gives one letter rather than repeating it", () => {
    expect(initialsOf("شيماء")).toBe("ش");
  });

  test("the definite article is not the family name", () => {
    expect(initialsOf("هشام محمود الديب")).toBe("هد");
    // «ال» alone is all there is, so there is nothing to strip down to.
    expect(initialsOf("سارة ال")).toBe("سا");
  });

  test("surrounding and doubled whitespace is not a word", () => {
    expect(initialsOf("  هشام   الديب  ")).toBe("هد");
    expect(initialsOf("")).toBe("");
  });
});

describe("the avatar", () => {
  test("with no photo it draws initials, not a broken image", () => {
    render(
      <LocaleProvider>
        <Avatar name="منى سيد فهمي" src={null} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("avatar-initials").textContent).toBe("مف");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("with a photo it draws the image, and the name is the title rather than the alt", () => {
    render(
      <LocaleProvider>
        <Avatar name="منى سيد فهمي" src="blob:photo" />
      </LocaleProvider>,
    );
    const image = screen.getByRole("img");
    expect(image.getAttribute("src")).toBe("blob:photo");
    // The name is already beside every avatar this app draws; an alt repeating it says it twice.
    expect(image.getAttribute("title")).toBe("منى سيد فهمي");
    expect(screen.queryByTestId("avatar-initials")).toBeNull();
  });
});
