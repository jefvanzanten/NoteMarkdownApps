import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translations", () => {
  it("contains primary-flow text in both languages", () => {
    expect(translate("en", "openDirectory")).toBe("Open local directory");
    expect(translate("nl", "openDirectory")).toBe("Lokale map openen");
  });
});
