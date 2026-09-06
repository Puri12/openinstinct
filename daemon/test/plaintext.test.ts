import { describe, expect, test } from "bun:test";
import { toPlainText } from "../src/delivery/plaintext.ts";

describe("toPlainText", () => {
  test("strips Markdown the model emits anyway", () => {
    const input = "## 결과\n\n**관측된 패턴**\n1. `git pull` 반복\n- 두 번째 *항목*\n\n```sh\nbrew install x\n```\n[링크](https://a.b/c)\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(toPlainText(input)).toBe("결과\n\n관측된 패턴\n1. git pull 반복\n• 두 번째 항목\n\nbrew install x\n링크 https://a.b/c\n\na  b\n1  2");
  });
  test("leaves plain Korean text, math, and emphasis-free underscores alone", () => {
    const t = "2*3=6 이고 snake_case_name 은 그대로. 5 * 4 도 그대로.";
    expect(toPlainText(t)).toBe(t);
  });
});
