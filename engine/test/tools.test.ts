import assert from "node:assert/strict";
import { test } from "node:test";
import { cropPath } from "../src/tools.ts";

const evaluate = (expr: string, t: number) =>
  expr.split(/\+(?=gte)/).reduce((sum, part) => {
    const a = part.match(/gte\(t,([\d.]+)\)/);
    const b = part.match(/lt\(t,([\d.]+)\)/);
    if ((a && t < Number(a[1])) || (b && t >= Number(b[1]))) return sum;
    const body = part.match(/\((\d+)\+\(t-([\d.]+)\)\*(-?[\d.]+)\)$/);
    return sum + (body ? Number(body[1]) + (t - Number(body[2])) * Number(body[3]) : Number(part.split("*").pop()));
  }, 0);

test("the crop never doubles on a boundary frame and holds after the last sample", () => {
  const expr = cropPath([0, 1, 2], [100, 200, 300]);
  assert.equal(evaluate(expr, 1), 200);
  assert.equal(evaluate(expr, 0.5), 150);
  assert.equal(evaluate(expr, 2), 300);
  assert.equal(evaluate(expr, 9), 300);
});
